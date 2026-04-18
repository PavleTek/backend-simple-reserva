const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { sendReservationConfirmation, sendModificationAlertToCustomer } = require('../services/notificationService');
const { canCreateReservation, canSendConfirmations } = require('../services/subscriptionService');
const { getRestaurant, updateRestaurant, completeOnboarding } = require('../controllers/restaurantController');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { isSlotInSchedule, generateTimeSlots, resolveDuration } = require('../utils/scheduleUtils');
const { NotFoundError, ValidationError } = require('../utils/errors');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  formatInTimezone,
  getDayOfWeekInTimezone,
} = require('../utils/timezone');
const { incrementDataVersion } = require('../utils/dataVersion');
const { incrementReservationAnalytics } = require('../services/reservationAnalyticsService');
const { pickAutoTable, sortFreeTablesForUi } = require('../lib/tableAssignment');

const router = express.Router({ mergeParams: true });

router.get('/data-version', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId || req.activeRestaurant?.restaurantId;
    
    if (!restaurantId) {
      throw new ValidationError('ID de restaurante no proporcionado');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { dataVersion: true },
    });
    
    if (!restaurant) {
      throw new NotFoundError('Restaurante no encontrado');
    }

    const config = await prisma.configuration.findFirst({
      select: { dashboardPollingIntervalSeconds: true },
    });
    
    res.json({
      version: restaurant.dataVersion,
      pollingIntervalSeconds: config?.dashboardPollingIntervalSeconds ?? 30,
    });
  } catch (error) {
    next(error);
  }
});

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']));

router.get('/', getRestaurant);
router.patch('/', authenticateRestaurantRoles(['restaurant_owner']), updateRestaurant);
router.patch('/onboarding/complete', authenticateRestaurantRoles(['restaurant_owner']), completeOnboarding);

router.get('/duration-rules', async (req, res, next) => {
  try {
    const rules = await prisma.durationRule.findMany({
      where: { restaurantId: req.activeRestaurant.restaurantId },
      orderBy: { minPartySize: 'asc' },
    });
    res.json(rules);
  } catch (error) {
    next(error);
  }
});

router.put('/duration-rules', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const { rules } = req.body;
    if (!Array.isArray(rules)) {
      throw new ValidationError('rules debe ser un array');
    }
    await prisma.$transaction(async (tx) => {
      await tx.durationRule.deleteMany({ where: { restaurantId } });
      if (rules.length > 0) {
        const valid = rules
          .filter((r) => r.minPartySize != null && r.maxPartySize != null && r.durationMinutes != null)
          .map((r) => ({
            restaurantId,
            minPartySize: Math.max(1, parseInt(r.minPartySize, 10) || 1),
            maxPartySize: Math.min(50, Math.max(1, parseInt(r.maxPartySize, 10) || 2)),
            durationMinutes: Math.min(240, Math.max(15, parseInt(r.durationMinutes, 10) || 60)),
          }))
          .sort((a, b) => a.minPartySize - b.minPartySize);
        const byMin = new Map();
        valid.forEach((v) => byMin.set(v.minPartySize, v));
        const unique = Array.from(byMin.values());
        if (unique.length > 0) {
          await tx.durationRule.createMany({ data: unique });
        }
      }
    });
    const updated = await prisma.durationRule.findMany({
      where: { restaurantId },
      orderBy: { minPartySize: 'asc' },
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/tables/status', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const dateParam = req.query.date;

    const [zones, reservations, restaurant] = await Promise.all([
      prisma.zone.findMany({
        where: { restaurantId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          tables: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
          },
        },
      }),
      prisma.reservation.findMany({
        where: {
          restaurantId,
          status: 'confirmed',
          // Boundary filtering will be added below after resolving TZ
        },
        include: { table: { select: { id: true, label: true } } },
        orderBy: { dateTime: 'asc' },
      }),
      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { 
          bufferMinutesBetweenReservations: true,
          timezone: true,
          organization: { include: { owner: { select: { country: true } } } }
        },
      }),
    ]);

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const nowTZ = nowInTimezone(timezone);
    const todayLocal = nowTZ.toFormat('yyyy-MM-dd');
    const dateStr = dateParam || todayLocal;
    const dayStart = parseInTimezone(dateStr, '00:00', timezone);
    const dayEnd = parseInTimezone(dateStr, '23:59', timezone);
    const isToday = dateStr === todayLocal;
    const now = isToday ? nowTZ.toJSDate() : dayStart;

    // Re-filter reservations with correct boundaries
    const filteredReservations = reservations.filter(r => 
      r.dateTime >= dayStart && r.dateTime <= dayEnd
    );

    const bufferMs = (restaurant?.bufferMinutesBetweenReservations ?? 0) * 60000;

    const zonesWithStatus = zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      tables: zone.tables.map((table) => {
        const tableReservations = filteredReservations.filter((r) => r.tableId === table.id);
        let status = 'free';
        let currentReservation = null;
        let nextReservation = null;
        let lateReservation = null;

        for (const r of tableReservations) {
          const rStart = r.dateTime;
          const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
          const minutesUntilStart = (rStart.getTime() - now.getTime()) / 60000;

          if (now >= rStart && now < rEnd) {
            status = 'occupied';
            currentReservation = {
              id: r.id,
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              partySize: r.partySize,
              dateTime: r.dateTime,
              dateTimeEnd: rEnd,
            };
            break;
          }
          if (now > rEnd && !lateReservation) {
            lateReservation = {
              id: r.id,
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              partySize: r.partySize,
              dateTime: r.dateTime,
            };
            status = 'late_arrival';
          }
          if (r.dateTime > now) {
            nextReservation = nextReservation || {
              id: r.id,
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              partySize: r.partySize,
              dateTime: r.dateTime,
            };
            if (minutesUntilStart <= 60) {
              status = 'reserved_soon';
            } else if (status === 'free') {
              status = 'upcoming';
            }
            break;
          }
        }

        if (status === 'free' && nextReservation) status = 'upcoming';
        if (status === 'late_arrival' && lateReservation) {
          currentReservation = lateReservation;
        }

        return {
          id: table.id,
          label: table.label,
          minCapacity: table.minCapacity,
          maxCapacity: table.maxCapacity,
          createdAt: table.createdAt.toISOString(),
          status,
          currentReservation,
          nextReservation,
        };
      }),
    }));

    res.json({ date: dateStr, zones: zonesWithStatus });
  } catch (error) {
    next(error);
  }
});

router.get('/availability', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const { date, partySize, walkIn: walkInQuery } = req.query;

    if (!date || !partySize) {
      throw new ValidationError('Se requieren date y partySize');
    }

    /** Walk-in desde el panel: próximo cupo desde ahora (sin antelación mínima de reserva web). */
    const walkIn = walkInQuery === 'true' || walkInQuery === '1';

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const requestedDate = parseInTimezone(date, '00:00', timezone);
    // Day-of-week MUST be in the restaurant's timezone (see utils/timezone.js).
    const dayOfWeek = getDayOfWeekInTimezone(date, timezone);

    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      return res.json({ slots: [], reason: 'no_schedule' });
    }

    const tablesWhere = {
      isActive: true,
      minCapacity: { lte: size },
      maxCapacity: { gte: size },
      zone: { restaurantId, isActive: true },
    };
    const tables = await prisma.restaurantTable.findMany({
      where: tablesWhere,
      orderBy: { maxCapacity: 'asc' },
    });

    if (tables.length === 0) return res.json({ slots: [], reason: 'no_tables' });

    const durationRules = await prisma.durationRule.findMany({
      where: { restaurantId },
    });
    const duration = resolveDuration(restaurant, size, durationRules);
    const slotDefs = generateTimeSlots(schedule, duration, restaurant.scheduleMode);
    const timeSlots = slotDefs.map(({ time }) => {
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
          restaurantId,
          startDatetime: { lte: dayEnd },
          endDatetime: { gte: dayStart },
        },
      }),
      prisma.reservation.findMany({
        where: {
          restaurantId,
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
    const minSlotTime = isToday
      ? walkIn
        ? now
        : new Date(now.getTime() + minNotice * 60000)
      : null;

    const available = [];
    /** Comparar por minuto para evitar desfaces de ms entre slot y now+aviso */
    const minSlotMinute = isToday && minSlotTime ? Math.floor(minSlotTime.getTime() / 60000) : null;
    for (const slot of timeSlots) {
      if (isToday && minSlotMinute != null) {
        const slotMinute = Math.floor(slot.start.getTime() / 60000);
        if (slotMinute < minSlotMinute) continue;
      }

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
        available.push({ time: slot.time, available: true, availableTables: openTables });
      }
    }

    const meta = {
      minNoticeMinutes: minNotice,
      timezone,
      isToday,
      walkIn,
      /** Primera hora local (HH:mm) a la que aplica el aviso mínimo hoy; null si walk-in o no es hoy */
      earliestBookableTimeLocal:
        isToday && !walkIn && minSlotTime
          ? formatInTimezone(minSlotTime, timezone, 'HH:mm')
          : null,
      /** Paso entre cupos (min), igual que duration usada para la grilla */
      slotStepMinutes: duration,
    };

    res.json({
      slots: available,
      durationMinutes: duration,
      meta,
      reason: available.length === 0 ? 'no_availability' : undefined,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/available-tables', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const { date, time, partySize, excludeReservationId } = req.query;

    if (!date || !time || !partySize) {
      throw new ValidationError('Se requieren date, time y partySize');
    }

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const timeStr = String(time).trim();
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
      throw new ValidationError('Formato de hora inválido (HH:MM)');
    }

    const dateTime = parseInTimezone(date, timeStr, timezone);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Fecha u hora inválida');
    }

    const durationRules = await prisma.durationRule.findMany({
      where: { restaurantId },
    });
    const duration = resolveDuration(restaurant, size, durationRules);
    const slotEnd = new Date(dateTime.getTime() + duration * 60000);

    const tables = await prisma.restaurantTable.findMany({
      where: {
        isActive: true,
        minCapacity: { lte: size },
        maxCapacity: { gte: size },
        zone: { restaurantId, isActive: true },
      },
      include: { zone: { select: { id: true, name: true, sortOrder: true } } },
    });

    if (tables.length === 0) {
      return res.json({ tables: [] });
    }

    const dayStart = parseInTimezone(date, '00:00', timezone);
    const dayEnd = parseInTimezone(date, '23:59', timezone);

    const whereReservations = {
      restaurantId,
      tableId: { in: tables.map((t) => t.id) },
      status: 'confirmed',
      dateTime: { gte: dayStart, lte: dayEnd },
    };
    if (excludeReservationId) {
      whereReservations.id = { not: excludeReservationId };
    }

    const existingReservations = await prisma.reservation.findMany({
      where: whereReservations,
    });

    const blockedSlots = await prisma.blockedSlot.findMany({
      where: {
        restaurantId,
        startDatetime: { lt: slotEnd },
        endDatetime: { gt: dateTime },
      },
    });
    const isBlocked = blockedSlots.length > 0;

    const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
    const freeTables = [];
    for (const table of tables) {
      if (isBlocked) continue;
      const booked = existingReservations.some((r) => {
        if (r.tableId !== table.id) return false;
        const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
        return dateTime < rEnd && slotEnd > r.dateTime;
      });
      if (!booked) freeTables.push(table);
    }

    const ordered = sortFreeTablesForUi(freeTables, size, null);
    const available = ordered.map((table) => ({
      id: table.id,
      label: table.label,
      zoneName: table.zone.name,
    }));

    res.json({ tables: available });
  } catch (error) {
    next(error);
  }
});

// --- Reservations sub-routes ---

router.get('/reservations', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { date, dateFrom, dateTo, status, search, sort } = req.query;

    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const where = { restaurantId };

    if (date) {
      const start = parseInTimezone(date, '00:00', timezone);
      const end = parseInTimezone(date, '23:59', timezone);
      where.dateTime = { gte: start, lte: end };
    } else if (dateFrom && dateTo) {
      const start = parseInTimezone(dateFrom, '00:00', timezone);
      const end = parseInTimezone(dateTo, '23:59', timezone);
      where.dateTime = { gte: start, lte: end };
    }

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderAsc = sort !== 'desc';

    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        include: { table: { select: { id: true, label: true } } },
        orderBy: { dateTime: orderAsc ? 'asc' : 'desc' },
        skip,
        take: limit,
      }),
      prisma.reservation.count({ where }),
    ]);

    res.json(paginatedResponse(reservations, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.post('/reservations', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const {
      date,
      time,
      partySize,
      customerName,
      customerPhone,
      customerEmail,
      notes,
      tableId,
      walkIn,
    } = req.body;

    const isWalkIn = walkIn === true;

    if (!date || !time || !partySize) {
      throw new ValidationError('Se requiere date, time y partySize');
    }

    let name = typeof customerName === 'string' ? customerName.trim() : '';
    let phone = typeof customerPhone === 'string' ? customerPhone.trim() : '';

    if (isWalkIn) {
      if (!name) name = 'Walk-in';
      if (!phone) phone = '—';
    } else if (!name || !phone) {
      throw new ValidationError('Se requiere customerName y customerPhone');
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: { include: { owner: { select: { country: true } } } }
      }
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const { allowed, reason } = await canCreateReservation(restaurantId);
    if (!allowed) throw new ValidationError(reason);

    const dateTime = parseInTimezone(date, time, timezone);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Formato de fecha u hora inválido');
    }

    const durationRules = await prisma.durationRule.findMany({
      where: { restaurantId },
    });
    const slotDuration = resolveDuration(restaurant, size, durationRules);
    const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
    // Day-of-week and slot minutes derived from the request strings interpreted in
    // the restaurant's timezone — never via dateTime.getDay()/getHours() (which use
    // the server's local timezone, see utils/timezone.js).
    const dayOfWeek = getDayOfWeekInTimezone(date, timezone);
    const [reqH, reqM] = String(time).split(':').map(Number);
    const reqMinutes = reqH * 60 + reqM;

    const reservation = await prisma.$transaction(
      async (tx) => {
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

        if (!isSlotInSchedule(schedule, reqMinutes, slotDuration, restaurant.scheduleMode)) {
          throw new ValidationError('La hora solicitada está fuera del horario de atención');
        }

        const blocked = await tx.blockedSlot.findFirst({
          where: {
            restaurantId,
            startDatetime: { lt: slotEnd },
            endDatetime: { gt: dateTime },
          },
        });
        if (blocked) {
          throw new ValidationError(
            'Este horario está bloqueado' + (blocked.reason ? ': ' + blocked.reason : '')
          );
        }

        const tablesWhere = {
          isActive: true,
          minCapacity: { lte: size },
          maxCapacity: { gte: size },
          zone: { restaurantId, isActive: true },
        };

        let selectedTable = null;
        if (tableId) {
          const table = await tx.restaurantTable.findUnique({
            where: { id: tableId },
            include: { zone: true },
          });
          if (!table || table.zone.restaurantId !== restaurantId) {
            throw new ValidationError('Mesa no válida');
          }
          if (table.minCapacity > size || table.maxCapacity < size) {
            throw new ValidationError('La mesa no admite este número de comensales');
          }
          selectedTable = table;
        } else {
          const tables = await tx.restaurantTable.findMany({
            where: tablesWhere,
            include: { zone: { select: { id: true, sortOrder: true } } },
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

          const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
          selectedTable = pickAutoTable(tables, size, dayReservations, dateTime, slotEnd, bufferMs, null);

          if (!selectedTable) {
            throw new ValidationError('No hay mesas disponibles en este horario');
          }
        }

        return tx.reservation.create({
          data: {
            restaurantId,
            tableId: selectedTable.id,
            customerName: name,
            customerPhone: phone,
            customerEmail: customerEmail?.trim() || null,
            partySize: size,
            dateTime,
            durationMinutes: slotDuration,
            notes: notes?.trim() || null,
            source: 'manual',
          },
          include: {
            restaurant: { select: { name: true } },
            table: { select: { id: true, label: true } },
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );

    if (!isWalkIn) {
      canSendConfirmations(restaurantId).then((ok) => {
        if (ok) {
          sendReservationConfirmation({
            customerPhone: phone,
            restaurantName: restaurant.name,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
            restaurantId,
          }).catch((err) => console.error('[Notification] Confirmation failed:', err));
        }
      });
    }

    incrementDataVersion(restaurantId).catch(console.error);

    incrementReservationAnalytics(restaurantId, restaurant.organizationId, new Date())
      .catch(err => console.error('[ReservationAnalytics] Error:', err));

    res.status(201).json(reservation);
  } catch (error) {
    next(error);
  }
});

router.patch('/reservations/:id', async (req, res, next) => {
  try {
    const { status, date, time, partySize, tableId, notes } = req.body;

    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { restaurant: true, table: { select: { id: true, label: true } } },
    });

    if (!reservation) {
      throw new NotFoundError('Reserva no encontrada');
    }

    if (reservation.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Reserva no encontrada');
    }

    // Full edit (date, time, partySize, table, notes)
    if (date !== undefined || time !== undefined || partySize !== undefined || tableId !== undefined || notes !== undefined) {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: reservation.restaurantId },
        include: {
          organization: { include: { owner: { select: { country: true } } } }
        }
      });
      if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

      const ownerCountry = restaurant.organization?.owner?.country || 'CL';
      const timezone = getEffectiveTimezone(restaurant, ownerCountry);

      const dateStr = date !== undefined ? (typeof date === 'string' ? date.split('T')[0] : new Date(date).toISOString().split('T')[0]) : formatInTimezone(reservation.dateTime, timezone, 'yyyy-MM-dd');
      const timeStr = time !== undefined ? String(time).trim() : formatInTimezone(reservation.dateTime, timezone, 'HH:mm');
      const size = partySize !== undefined ? parseInt(partySize, 10) : reservation.partySize;

      if (isNaN(size) || size < 1) {
        throw new ValidationError('partySize debe ser un número positivo');
      }

      const dateTime = parseInTimezone(dateStr, timeStr, timezone);
      if (isNaN(dateTime.getTime())) {
        throw new ValidationError('Formato de fecha u hora inválido');
      }

      const durationRules = await prisma.durationRule.findMany({
        where: { restaurantId: restaurant.id },
      });
      const slotDuration = resolveDuration(restaurant, size, durationRules);
      const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
      // Day-of-week and slot minutes in the restaurant's timezone
      // (see utils/timezone.js — never use dateTime.getDay()/getHours() here).
      const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);
      const [reqH, reqM] = String(timeStr).split(':').map(Number);
      const reqMinutes = reqH * 60 + reqM;

      const updated = await prisma.$transaction(
        async (tx) => {
          const schedule = await tx.schedule.findFirst({
            where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
          });
          if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

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

          const tablesWhere = {
            isActive: true,
            minCapacity: { lte: size },
            maxCapacity: { gte: size },
            zone: { restaurantId: restaurant.id, isActive: true },
          };

          let selectedTable = null;
          let tableIdVal = tableId;
          if (tableId != null && typeof tableId === 'object' && 'value' in tableId) {
            tableIdVal = tableId.value;
          }
          const tableIdStr = (tableIdVal != null && String(tableIdVal).trim()) || null;
          if (tableIdStr) {
            const table = await tx.restaurantTable.findUnique({
              where: { id: tableIdStr },
              include: { zone: true },
            });
            if (!table || table.zone.restaurantId !== restaurant.id) {
              throw new ValidationError('Mesa no válida');
            }
            if (table.minCapacity > size || table.maxCapacity < size) {
              throw new ValidationError('La mesa no admite este número de comensales');
            }
            const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
            const conflictingSlots = await tx.reservation.findMany({
              where: {
                tableId: table.id,
                status: 'confirmed',
                id: { not: reservation.id },
                dateTime: { gte: parseInTimezone(dateStr, '00:00', timezone), lte: parseInTimezone(dateStr, '23:59', timezone) },
              },
            });
            const hasConflict = conflictingSlots.some((r) => {
              const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
              return dateTime < rEnd && slotEnd > r.dateTime;
            });
            if (hasConflict) {
              throw new ValidationError(
                'Esa mesa ya tiene una reserva en ese horario. Elige otra mesa o cambia la hora.'
              );
            }
            selectedTable = table;
          } else {
            const tables = await tx.restaurantTable.findMany({
              where: tablesWhere,
              include: { zone: { select: { id: true, sortOrder: true } } },
            });
            if (tables.length === 0) {
              throw new ValidationError('No hay mesas disponibles para este número de comensales');
            }

            const dayStart = parseInTimezone(dateStr, '00:00', timezone);
            const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

            const dayReservations = await tx.reservation.findMany({
              where: {
                tableId: { in: tables.map((t) => t.id) },
                status: 'confirmed',
                dateTime: { gte: dayStart, lte: dayEnd },
                id: { not: reservation.id },
              },
            });

            const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
            selectedTable = pickAutoTable(tables, size, dayReservations, dateTime, slotEnd, bufferMs, null);

            if (!selectedTable) {
              throw new ValidationError('No hay mesas disponibles en este horario');
            }
          }

          return tx.reservation.update({
            where: { id: req.params.id },
            data: {
              dateTime,
              partySize: size,
              tableId: selectedTable.id,
              durationMinutes: slotDuration,
              ...(notes !== undefined && { notes: notes === '' ? null : String(notes).trim() || null }),
            },
            include: {
              restaurant: { select: { name: true } },
              table: { select: { id: true, label: true } },
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );

      if (date !== undefined || time !== undefined || partySize !== undefined) {
        sendModificationAlertToCustomer({
          customerPhone: updated.customerPhone,
          restaurantName: updated.restaurant.name,
          type: 'modified',
          dateTime: updated.dateTime,
          partySize: updated.partySize,
          restaurantId: reservation.restaurantId,
        }).catch((err) => console.error('[Notification] Admin edit alert failed:', err));
      }

      incrementDataVersion(reservation.restaurantId).catch(console.error);

      return res.json(updated);
    }

    // Status-only update
    if (!status) {
      throw new ValidationError('El estado es obligatorio cuando no se editan otros campos');
    }

    const allowedStatuses = ['confirmed', 'completed', 'cancelled', 'no_show'];
    if (!allowedStatuses.includes(status)) {
      throw new ValidationError('Estado no válido. Use: confirmed, completed, cancelled, no_show');
    }

    const updated = await prisma.reservation.update({
      where: { id: req.params.id },
      data: { status },
    });

    incrementDataVersion(reservation.restaurantId).catch(console.error);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// --- Blocked Slots sub-routes ---

router.get('/blocked-slots', async (req, res, next) => {
  try {
    const slots = await prisma.blockedSlot.findMany({
      where: { restaurantId: req.activeRestaurant.restaurantId },
      orderBy: { startDatetime: 'asc' },
    });

    res.json(slots);
  } catch (error) {
    next(error);
  }
});

router.post('/blocked-slots', async (req, res, next) => {
  try {
    const { startDatetime, endDatetime, reason } = req.body;

    if (!startDatetime || !endDatetime) {
      throw new ValidationError('Se requiere startDatetime y endDatetime');
    }

    const start = new Date(startDatetime);
    const end = new Date(endDatetime);
    if (end <= start) {
      throw new ValidationError('La fecha/hora de fin debe ser posterior a la de inicio');
    }

    const slot = await prisma.blockedSlot.create({
      data: {
        restaurantId: req.activeRestaurant.restaurantId,
        startDatetime: start,
        endDatetime: end,
        reason: reason || null,
      },
    });

    res.status(201).json(slot);
  } catch (error) {
    next(error);
  }
});

router.delete('/blocked-slots/:id', async (req, res, next) => {
  try {
    const slot = await prisma.blockedSlot.findUnique({
      where: { id: req.params.id },
    });

    if (!slot) {
      throw new NotFoundError('Franja bloqueada no encontrada');
    }

    if (slot.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Franja bloqueada no encontrada');
    }

    await prisma.blockedSlot.delete({ where: { id: req.params.id } });

    res.json({ message: 'Franja bloqueada eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
