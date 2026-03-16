const express = require('express');
const prisma = require('../lib/prisma');
const { isSlotInSchedule, generateTimeSlots } = require('../utils/scheduleUtils');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { 
  sendReservationConfirmation, 
  sendCancellationNotification, 
  sendModificationAlertToCustomer,
  sendReservationConfirmationEmail 
} = require('../services/notificationService');
const { canCreateReservation, canSendConfirmations, hasActiveAccess } = require('../services/subscriptionService');
const { getEffectiveTimezone, parseInTimezone, nowInTimezone } = require('../utils/timezone');
const { incrementDataVersion } = require('../utils/dataVersion');
const { incrementReservationAnalytics } = require('../services/reservationAnalyticsService');

const router = express.Router();

// ─── Token-based reservation routes ─────────────────────────────
// Defined before /:slug params to avoid route collisions when
// this router is mounted at both /api/restaurants and /api/reservations

router.get('/token/:secureToken', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: { 
          select: { 
            id: true,
            name: true, 
            slug: true, 
            address: true,
            phone: true,
            timezone: true,
            organization: { include: { owner: { select: { country: true } } } }
          } 
        },
        table: { select: { label: true } },
      },
    });

    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    const ownerCountry = reservation.restaurant.organization?.owner?.country || 'CL';
    const effectiveTimezone = getEffectiveTimezone(reservation.restaurant, ownerCountry);

    res.json({
      ...reservation,
      restaurant: {
        ...reservation.restaurant,
        effectiveTimezone
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /token/:secureToken - Modify reservation (date, time, partySize)
router.patch('/token/:secureToken', async (req, res, next) => {
  try {
    const { date, time, partySize } = req.body;
    if (!date || !time || !partySize) {
      throw new ValidationError('Se requieren date, time y partySize');
    }

    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: {
          include: {
            organization: { include: { owner: { select: { country: true } } } }
          }
        },
        table: true,
      },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');
    if (reservation.status !== 'confirmed') {
      throw new ValidationError('Solo se pueden modificar reservas confirmadas');
    }

    const restaurant = reservation.restaurant;
    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const [datePart] = date.split('T');
    const dateTime = parseInTimezone(datePart, time, timezone);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Formato de fecha u hora inválido');
    }

    const dayOfWeek = dateTime.getDay(); // Note: luxon toJSDate() follows JS getDay() (0=Sun)
    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      throw new ValidationError('El restaurante está cerrado este día');
    }

    const slotDuration = restaurant.defaultSlotDurationMinutes;
    const [timeH, timeM] = time.split(':').map(Number);
    const timeMin = timeH * 60 + timeM;
    if (!isSlotInSchedule(schedule, timeMin, slotDuration, restaurant.scheduleMode)) {
      throw new ValidationError('La hora solicitada está fuera del horario de atención');
    }

    const dayStart = parseInTimezone(datePart, '00:00', timezone);
    const dayEnd = parseInTimezone(datePart, '23:59', timezone);
    const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);

    const tablesWhere = {
      isActive: true,
      minCapacity: { lte: size },
      maxCapacity: { gte: size },
      zone: { restaurantId: restaurant.id, isActive: true },
    };
    const tables = await prisma.restaurantTable.findMany({
      where: tablesWhere,
      include: { zone: true },
      orderBy: { maxCapacity: 'asc' },
    });
    if (tables.length === 0) {
      throw new ValidationError('No hay mesas para este número de comensales');
    }

    const [blockedSlots, dayReservations] = await Promise.all([
      prisma.blockedSlot.findMany({
        where: {
          restaurantId: restaurant.id,
          startDatetime: { lte: dayEnd },
          endDatetime: { gte: dayStart },
        },
      }),
      prisma.reservation.findMany({
        where: {
          restaurantId: restaurant.id,
          tableId: { in: tables.map((t) => t.id) },
          status: 'confirmed',
          dateTime: { gte: dayStart, lte: dayEnd },
          id: { not: reservation.id },
        },
      }),
    ]);

    const isBlocked = blockedSlots.some(
      (bs) => dateTime < bs.endDatetime && slotEnd > bs.startDatetime
    );
    if (isBlocked) {
      throw new ValidationError('Este horario está bloqueado');
    }

    const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
    let selectedTable = null;
    for (const table of tables) {
      const booked = dayReservations.some((r) => {
        if (r.tableId !== table.id) return false;
        const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
        return dateTime < rEnd && slotEnd > r.dateTime;
      });
      if (!booked) {
        selectedTable = table;
        break;
      }
    }
    if (!selectedTable) {
      throw new ValidationError('No hay disponibilidad en este horario');
    }

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        dateTime,
        partySize: size,
        tableId: selectedTable.id,
        durationMinutes: slotDuration,
      },
      include: {
        restaurant: { select: { name: true, slug: true } },
        table: { select: { label: true } },
      },
    });

    sendModificationAlertToCustomer({
      customerPhone: reservation.customerPhone,
      restaurantName: reservation.restaurant.name,
      type: 'modified',
      dateTime,
      partySize: size,
      restaurantId: restaurant.id,
    }).catch((err) => console.error('[Notification] Modification alert failed:', err));

    incrementDataVersion(restaurant.id).catch(console.error);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/token/:secureToken/cancel', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: {
          include: {
            organization: { include: { owner: { select: { email: true } } } }
          }
        },
        table: { select: { label: true } },
      },
    });

    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: 'cancelled' },
      include: {
        restaurant: { select: { name: true, slug: true } },
        table: { select: { label: true } },
      },
    });

    // Notify restaurant (non-blocking)
    const panelBase = process.env.RESTAURANT_PANEL_URL || process.env.BOOKING_BASE_URL || 'http://localhost:5175';
    const panelUrl = `${panelBase.replace(/\/$/, '')}/reservations?date=${new Date(reservation.dateTime).toISOString().split('T')[0]}`;
    const emails = [...new Set(
      [reservation.restaurant?.organization?.owner?.email].filter(Boolean),
    )];
    sendCancellationNotification({
      emails,
      restaurantName: reservation.restaurant?.name || 'Restaurante',
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      dateTime: reservation.dateTime,
      partySize: reservation.partySize,
      panelUrl,
      restaurantId: reservation.restaurantId,
    }).catch((err) => console.error('[Reservation] Cancellation notification failed:', err.message));

    sendModificationAlertToCustomer({
      customerPhone: reservation.customerPhone,
      restaurantName: reservation.restaurant?.name || 'Restaurante',
      type: 'cancelled',
      restaurantId: reservation.restaurantId,
    }).catch((err) => console.error('[Notification] Cancellation alert failed:', err));

    incrementDataVersion(reservation.restaurantId).catch(console.error);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// ─── Create reservation ─────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const {
      restaurantSlug,
      date,
      time,
      partySize,
      customerName,
      customerPhone,
      customerEmail,
      notes,
      preferredZoneId,
    } = req.body;

    if (!restaurantSlug || !date || !time || !partySize || !customerName || !customerPhone) {
      throw new ValidationError(
        'Se requiere restaurantSlug, date, time, partySize, customerName y customerPhone'
      );
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: restaurantSlug, isActive: true },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const { allowed, reason } = await canCreateReservation(restaurant.id);
    if (!allowed) throw new ValidationError(reason);

    const dateTime = parseInTimezone(date, time, timezone);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Formato de fecha u hora inválido');
    }

    const now = nowInTimezone(timezone).toJSDate();
    const advanceDays = restaurant.advanceBookingLimitDays ?? 30;
    const limitDateObj = nowInTimezone(timezone).plus({ days: advanceDays });
    const limitDateFinal = limitDateObj.set({ hour: 23, minute: 59, second: 59, millisecond: 999 }).toJSDate();

    if (dateTime > limitDateFinal) {
      throw new ValidationError(`Solo se puede reservar hasta ${advanceDays} días por adelantado`);
    }

    const minNotice = restaurant.minimumNoticeMinutes ?? 60;
    const minTime = new Date(now.getTime() + minNotice * 60000);
    if (dateTime < minTime) {
      throw new ValidationError(
        minNotice >= 60
          ? `Debes reservar con al menos ${Math.floor(minNotice / 60)} hora(s) de anticipación`
          : 'La reserva debe ser con al menos unos minutos de anticipación'
      );
    }

    const slotDuration = restaurant.defaultSlotDurationMinutes;
    const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
    const dayOfWeek = dateTime.getDay();

    const reservation = await prisma.$transaction(
      async (tx) => {
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

        const reqMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
        if (!isSlotInSchedule(schedule, reqMinutes, slotDuration, restaurant.scheduleMode)) {
          throw new ValidationError('La hora solicitada está fuera del horario de atención');
        }

        const blocked = await tx.blockedSlot.findFirst({
          where: {
            restaurantId: restaurant.id,
            startDatetime: { lt: slotEnd },
            endDatetime: { gt: dateTime },
          },
        });
        if (blocked) {
          throw new ValidationError(
            'Este horario está bloqueado' + (blocked.reason ? ': ' + blocked.reason : '')
          );
        }

        const tables = await tx.restaurantTable.findMany({
          where: {
            isActive: true,
            minCapacity: { lte: size },
            maxCapacity: { gte: size },
            zone: { restaurantId: restaurant.id, isActive: true },
          },
          include: { zone: { select: { id: true } } },
          orderBy: { maxCapacity: 'asc' },
        });
        if (tables.length === 0) {
          throw new ValidationError('No hay mesas disponibles para este número de comensales');
        }

        const dayStart = parseInTimezone(date, '00:00', timezone);
        const dayEnd = parseInTimezone(date, '23:59', timezone);

        const dayReservations = await tx.reservation.findMany({
          where: {
            tableId: { in: tables.map((t) => t.id) },
            status: 'confirmed',
            dateTime: { gte: dayStart, lte: dayEnd },
          },
        });

        const preferredTables = preferredZoneId
          ? tables.filter((t) => t.zone.id === preferredZoneId)
          : tables;
        const fallbackTables = preferredZoneId
          ? tables.filter((t) => t.zone.id !== preferredZoneId)
          : [];
        const tablesToTry = [...preferredTables, ...fallbackTables];

        const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
        let selectedTable = null;
        for (const table of tablesToTry) {
          const hasConflict = dayReservations.some((r) => {
            if (r.tableId !== table.id) return false;
            const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
            return dateTime < rEnd && slotEnd > r.dateTime;
          });
          if (!hasConflict) {
            selectedTable = table;
            break;
          }
        }

        if (!selectedTable) {
          throw new ValidationError('No hay mesas disponibles en este horario');
        }

        return tx.reservation.create({
          data: {
            restaurantId: restaurant.id,
            tableId: selectedTable.id,
            customerName,
            customerPhone,
            customerEmail: customerEmail || null,
            partySize: size,
            dateTime,
            durationMinutes: slotDuration,
            notes: notes || null,
            source: 'web',
          },
          include: {
            restaurant: { select: { name: true } },
            table: { select: { id: true, label: true } },
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );

    canSendConfirmations(restaurant.id).then((ok) => {
      if (ok) {
        sendReservationConfirmation({
          customerPhone,
          restaurantName: reservation.restaurant.name,
          dateTime: reservation.dateTime,
          partySize: size,
          secureToken: reservation.secureToken,
          restaurantId: restaurant.id,
        }).catch((err) => console.error('[Notification] Confirmation failed:', err));

        if (customerEmail) {
          sendReservationConfirmationEmail({
            customerEmail,
            restaurantName: reservation.restaurant.name,
            customerName,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
          }).catch((err) => console.error('[Notification] Email confirmation failed:', err));
        }
      }
    });

    incrementDataVersion(restaurant.id).catch(console.error);

    incrementReservationAnalytics(restaurant.id, restaurant.organizationId, new Date())
      .catch(err => console.error('[ReservationAnalytics] Error:', err));

    res.status(201).json(reservation);
  } catch (error) {
    next(error);
  }
});

// ─── Public restaurant routes (slug-based) ──────────────────────

router.get('/:slug/availability', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date, partySize, zoneId } = req.query;

    if (!date || !partySize) {
      throw new ValidationError('Se requieren los parámetros date y partySize');
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) {
      return res.json({ slots: [], reason: 'subscription_expired' });
    }

    const requestedDate = parseInTimezone(date, '00:00', timezone);
    const dayOfWeek = requestedDate.getDay();

    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      return res.json({ slots: [], reason: 'no_schedule' });
    }

    const tablesWhere = {
      isActive: true,
      minCapacity: { lte: size },
      maxCapacity: { gte: size },
      zone: zoneId
        ? { id: zoneId, restaurantId: restaurant.id, isActive: true }
        : { restaurantId: restaurant.id, isActive: true },
    };
    const tables = await prisma.restaurantTable.findMany({
      where: tablesWhere,
      orderBy: { maxCapacity: 'asc' },
    });

    if (!tables.length) return res.json({ slots: [], reason: 'no_tables' });

    const duration = restaurant.defaultSlotDurationMinutes;
    const slotDefs = generateTimeSlots(schedule, duration, restaurant.scheduleMode);
    const timeSlots = slotDefs.map(({ time, startMin }) => {
      const start = parseInTimezone(date, time, timezone);
      const end = new Date(start.getTime() + duration * 60000);
      return { time, start, end };
    });
    if (timeSlots.length === 0) return res.json({ slots: [], reason: 'no_slots' });

    const dayStart = parseInTimezone(date, '00:00', timezone);
    const dayEnd = parseInTimezone(date, '23:59', timezone);

    const [blockedSlots, existingReservations] = await Promise.all([
      prisma.blockedSlot.findMany({
        where: {
          restaurantId: restaurant.id,
          startDatetime: { lte: dayEnd },
          endDatetime: { gte: dayStart },
        },
      }),
      prisma.reservation.findMany({
        where: {
          restaurantId: restaurant.id,
          tableId: { in: tables.map((t) => t.id) },
          status: 'confirmed',
          dateTime: { gte: dayStart, lte: dayEnd },
        },
      }),
    ]);

    const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
    const minNotice = restaurant.minimumNoticeMinutes ?? 60;
    const now = nowInTimezone(timezone).toJSDate();
    const todayLocal = nowInTimezone(timezone).toFormat('yyyy-MM-dd');
    const isToday = date === todayLocal;
    const minSlotTime = new Date(now.getTime() + minNotice * 60000);

    const available = [];
    for (const slot of timeSlots) {
      if (isToday && slot.start < minSlotTime) continue;

      const isBlocked = blockedSlots.some(
        (bs) => slot.start < bs.endDatetime && slot.end > bs.startDatetime
      );
      if (isBlocked) continue;

      let openTables = 0;
      for (const table of tables) {
        const booked = existingReservations.some((r) => {
          if (r.tableId !== table.id) return false;
          const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
          return slot.start < rEnd && slot.end > r.dateTime;
        });
        if (!booked) openTables++;
      }

      if (openTables > 0) {
        available.push({ 
          time: slot.time, 
          available: true,
          availableTables: openTables 
        });
      }
    }

    if (available.length === 0) {
      return res.json({ slots: [], reason: 'no_availability' });
    }
    res.json({ slots: available });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: req.params.slug },
      select: {
        id: true,
        name: true,
        description: true,
        address: true,
        phone: true,
        email: true,
        menuPdfUrl: true,
        logoUrl: true,
        advanceBookingLimitDays: true,
        minimumNoticeMinutes: true,
        timezone: true,
        organizationId: true,
        organization: { include: { owner: { select: { country: true } } } },
        zones: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            tables: {
              where: { isActive: true },
              select: {
                id: true,
                label: true,
                minCapacity: true,
                maxCapacity: true,
              },
            },
          },
        },
        schedules: {
          where: { isActive: true },
          select: { dayOfWeek: true },
        },
      },
    });

    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const effectiveTimezone = getEffectiveTimezone(restaurant, ownerCountry);

    const access = await hasActiveAccess(restaurant.organizationId);
    const activeDays = [...new Set(restaurant.schedules.map((s) => s.dayOfWeek))];
    const { schedules, organization, ...rest } = restaurant;
    res.json({
      ...rest,
      activeDays,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays ?? 30,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes ?? 60,
      bookingEnabled: access,
      effectiveTimezone,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/restaurants/:slug/menus
 * Returns array of { menuType, url } for the public booking page
 */
router.get('/:slug/menus', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: req.params.slug },
      select: { id: true },
    });

    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const menus = await prisma.restaurantMenu.findMany({
      where: { restaurantId: restaurant.id },
      select: { menuType: true, url: true },
    });

    res.json(menus);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/restaurants/:slug/menu/:menuType
 * Redirects to R2 or streams the menu PDF
 */
router.get('/:slug/menu/:menuType', async (req, res, next) => {
  try {
    const { slug, menuType } = req.params;

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const menu = await prisma.restaurantMenu.findUnique({
      where: {
        restaurantId_menuType: {
          restaurantId: restaurant.id,
          menuType,
        },
      },
    });

    if (!menu) throw new NotFoundError('Menú no encontrado');

    // If R2_PUBLIC_URL is set, redirect to it
    if (process.env.R2_PUBLIC_URL) {
      const publicUrl = require('../services/r2Service').getPublicUrl(menu.r2Key);
      if (publicUrl) {
        return res.redirect(302, publicUrl);
      }
    }

    // Otherwise stream from R2
    const r2Service = require('../services/r2Service');
    const stream = await r2Service.getFileStream(menu.r2Key);
    
    res.setHeader('Content-Type', 'application/pdf');
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/restaurants/id/:restaurantId/menu/:menuType
 * Internal alias for when slug is not available (e.g. initial upload)
 */
router.get('/id/:restaurantId/menu/:menuType', async (req, res, next) => {
  try {
    const { restaurantId, menuType } = req.params;

    const menu = await prisma.restaurantMenu.findUnique({
      where: {
        restaurantId_menuType: {
          restaurantId,
          menuType,
        },
      },
    });

    if (!menu) throw new NotFoundError('Menú no encontrado');

    const r2Service = require('../services/r2Service');
    const stream = await r2Service.getFileStream(menu.r2Key);
    
    res.setHeader('Content-Type', 'application/pdf');
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
