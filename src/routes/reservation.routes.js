const express = require('express');
const prisma = require('../lib/prisma');
const { isSlotInSchedule, generateTimeSlots } = require('../utils/scheduleUtils');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sendReservationConfirmation, sendCancellationNotification } = require('../services/notificationService');
const { canCreateReservation, canSendConfirmations, hasActiveAccess } = require('../services/subscriptionService');

const router = express.Router();

// ─── Token-based reservation routes ─────────────────────────────
// Defined before /:slug params to avoid route collisions when
// this router is mounted at both /api/restaurants and /api/reservations

router.get('/token/:secureToken', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: { select: { name: true, slug: true } },
        table: { select: { label: true } },
      },
    });

    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    res.json(reservation);
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
        restaurant: true,
        table: true,
      },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');
    if (reservation.status !== 'confirmed') {
      throw new ValidationError('Solo se pueden modificar reservas confirmadas');
    }

    const restaurant = reservation.restaurant;
    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const [datePart] = date.split('T');
    const dateTime = new Date(`${datePart}T${time}`);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Formato de fecha u hora inválido');
    }

    const dayOfWeek = dateTime.getDay();
    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      throw new ValidationError('El restaurante está cerrado este día');
    }

    const slotDuration = restaurant.defaultSlotDurationMinutes;
    const [timeH, timeM] = time.split(':').map(Number);
    const timeMin = timeH * 60 + timeM;
    if (!isSlotInSchedule(schedule, timeMin, slotDuration)) {
      throw new ValidationError('La hora solicitada está fuera del horario de atención');
    }

    const dayStart = new Date(`${datePart}T00:00:00`);
    const dayEnd = new Date(`${datePart}T23:59:59`);
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
            userRestaurants: {
              where: { role: { in: ['owner', 'admin'] } },
              include: { user: { select: { email: true } } },
            },
          },
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
      (reservation.restaurant?.userRestaurants || []).map((ur) => ur.user?.email).filter(Boolean),
    )];
    sendCancellationNotification({
      emails,
      restaurantName: reservation.restaurant?.name || 'Restaurante',
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      dateTime: reservation.dateTime,
      partySize: reservation.partySize,
      panelUrl,
    }).catch((err) => console.error('[Reservation] Cancellation notification failed:', err.message));

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
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const { allowed, reason } = await canCreateReservation(restaurant.id);
    if (!allowed) throw new ValidationError(reason);

    const dateTime = new Date(`${date}T${time}:00`);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Formato de fecha u hora inválido');
    }

    const now = new Date();
    const advanceDays = restaurant.advanceBookingLimitDays ?? 30;
    const limitDate = new Date(now);
    limitDate.setDate(limitDate.getDate() + advanceDays);
    limitDate.setHours(23, 59, 59, 999);
    if (dateTime > limitDate) {
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
        if (!isSlotInSchedule(schedule, reqMinutes, slotDuration)) {
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

        const dayStart = new Date(`${date}T00:00:00`);
        const dayEnd = new Date(`${date}T23:59:59`);

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
            table: { select: { label: true } },
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
        }).catch((err) => console.error('[Notification] Confirmation failed:', err));
      }
    });

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

    console.log(`Checking availability for ${slug} on ${date} with partySize ${partySize}${zoneId ? ` zoneId ${zoneId}` : ''}`);

    if (!date || !partySize) {
      throw new ValidationError('Se requieren los parámetros date y partySize');
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const access = await hasActiveAccess(restaurant.id);
    if (!access) {
      return res.json({ slots: [], reason: 'subscription_expired' });
    }

    const requestedDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = requestedDate.getDay();

    console.log(`Day of week: ${dayOfWeek}`);

    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      console.log('No active schedule found for this day');
      return res.json({ slots: [], reason: 'no_schedule' });
    }

    console.log(`Schedule found: ${schedule.openTime} - ${schedule.closeTime}`);

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

    console.log(`Found ${tables.length} suitable tables`);

    if (tables.length === 0) return res.json({ slots: [], reason: 'no_tables' });

    const duration = restaurant.defaultSlotDurationMinutes;
    const slotDefs = generateTimeSlots(schedule, duration);
    const timeSlots = slotDefs.map(({ time, startMin }) => {
      const start = new Date(`${date}T${time}:00`);
      const end = new Date(start.getTime() + duration * 60000);
      return { time, start, end };
    });
    if (timeSlots.length === 0) return res.json({ slots: [], reason: 'no_slots' });

    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

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
    const available = [];
    for (const slot of timeSlots) {
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
      },
    });

    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const access = await hasActiveAccess(restaurant.id);
    res.json({ ...restaurant, bookingEnabled: access });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
