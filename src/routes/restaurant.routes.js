const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES, ROLES_OPERATIONAL, ROLES_CONFIG, ROLES_OWNER } = require('../auth/roles');
const {
  assertHostReservationEditWindow,
  assertHostPartySizeIncrease,
} = require('../auth/permissions');
const { writeAuditLog } = require('../services/auditLogService');
const {
  sendReservationConfirmation,
  sendReservationConfirmationEmail,
  sendModificationAlertToCustomer,
} = require('../services/notificationService');
const { canCreateReservation, canSendConfirmations, hasActiveAccess } = require('../services/subscriptionService');
const planService = require('../services/planService');
const { getRestaurant, updateRestaurant, completeOnboarding } = require('../controllers/restaurantController');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const {
  validateSlotForBooking,
  getAvailabilitySlotsForRestaurant,
  resolveDuration,
} = require('../services/slotEngine/index');
const { pickTable, parseReservations, parseHolds } = require('../services/slotEngine/capacity');
const { sortFreeTablesForUi } = require('../lib/tableAssignment');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  formatInTimezone,
  getDayOfWeekInTimezone,
} = require('../utils/timezone');
const { incrementDataVersion } = require('../utils/dataVersion');
const { incrementReservationAnalytics } = require('../services/reservationAnalyticsService');

async function withSerializableRetry(fn, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'P2034' && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
}

function dayLookbackMs(defaultSlotDurationMinutes, durationRules = []) {
  const maxDuration = durationRules.reduce(
    (max, r) => Math.max(max, r.durationMinutes),
    defaultSlotDurationMinutes ?? 60
  );
  return Math.max(maxDuration, 12 * 60) * 60000;
}

/** Walk-in desde el panel — alineado con `isWalkInReservation` en restaurant-front */
function reservationIsWalkIn(r) {
  const n = (r.notes || '').trim().toLowerCase();
  const name = (r.customerName || '').trim();
  return n === 'walk-in' || name === 'Walk-in' || name === 'walk-in';
}

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
router.use(authenticateRestaurantRoles(ROLES_OPERATIONAL));

router.get('/', getRestaurant);

/** Staff access check without exposing billing (hosts, managers on floor). */
router.get('/access-status', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');
    const hasAccess = await hasActiveAccess(restaurant.organizationId);
    let planConfig = null;
    if (hasAccess) {
      const resolved = await planService.resolvePlanConfigForRestaurant(restaurantId, true);
      if (resolved) {
        planConfig = {
          maxZonesPerRestaurant: resolved.maxZonesPerRestaurant ?? null,
          maxTables: resolved.maxTables ?? null,
        };
      }
    }
    res.json({ hasAccess, planConfig });
  } catch (error) {
    next(error);
  }
});

router.patch('/', authenticateRestaurantRoles(ROLES_OWNER), updateRestaurant);
router.patch('/onboarding/complete', authenticateRestaurantRoles(ROLES_OWNER), completeOnboarding);

router.get('/duration-rules', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
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

router.put('/duration-rules', authenticateRestaurantRoles(ROLES_OWNER), async (req, res, next) => {
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

router.get('/pacing-rules', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const rules = await prisma.pacingRule.findMany({
      where: { restaurantId: req.activeRestaurant.restaurantId },
      orderBy: [{ dayOfWeek: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(rules);
  } catch (error) {
    next(error);
  }
});

router.put('/pacing-rules', authenticateRestaurantRoles(ROLES_OWNER), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const { rules } = req.body;
    if (!Array.isArray(rules)) throw new ValidationError('rules debe ser un array');

    await prisma.$transaction(async (tx) => {
      await tx.pacingRule.deleteMany({ where: { restaurantId } });
      if (rules.length > 0) {
        const valid = rules.map((r) => ({
          restaurantId,
          dayOfWeek: r.dayOfWeek != null ? parseInt(r.dayOfWeek, 10) : null,
          maxCoversPerSlot: r.maxCoversPerSlot != null ? Math.max(1, parseInt(r.maxCoversPerSlot, 10)) : null,
          maxReservationsPerSlot: r.maxReservationsPerSlot != null ? Math.max(1, parseInt(r.maxReservationsPerSlot, 10)) : null,
        }));
        await tx.pacingRule.createMany({ data: valid });
      }
    });

    const updated = await prisma.pacingRule.findMany({
      where: { restaurantId },
      orderBy: [{ dayOfWeek: 'asc' }, { createdAt: 'asc' }],
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
      description: zone.description,
      smokingZone: zone.smokingZone,
      petFriendly: zone.petFriendly,
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
          if (now > rEnd) {
            if (reservationIsWalkIn(r)) {
              // Ya están en la mesa; el cupo nominal venció pero no es "atrasada" como una reserva web
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
            if (!lateReservation) {
              lateReservation = {
                id: r.id,
                customerName: r.customerName,
                customerPhone: r.customerPhone,
                partySize: r.partySize,
                dateTime: r.dateTime,
              };
              status = 'late_arrival';
            }
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
    const minNotice = restaurant.minimumNoticeMinutes ?? 60;
    const now = nowInTimezone(timezone).toJSDate();
    const todayLocal = nowInTimezone(timezone).toFormat('yyyy-MM-dd');
    const isToday = date === todayLocal;
    const minSlotTime = isToday
      ? walkIn
        ? now
        : new Date(now.getTime() + minNotice * 60000)
      : null;

    const result = await getAvailabilitySlotsForRestaurant(restaurant, {
      dateStr: date,
      partySize: size,
      zoneId: null,
      timezone,
      walkIn,
    });

    const duration =
      result.meta?.reservationDurationMinutes ??
      resolveDuration(restaurant, size, []);

    const meta = {
      minNoticeMinutes: minNotice,
      timezone,
      isToday,
      walkIn,
      earliestBookableTimeLocal:
        isToday && !walkIn && minSlotTime
          ? formatInTimezone(minSlotTime, timezone, 'HH:mm')
          : null,
      slotStepMinutes: result.meta?.slotIntervalMinutes ?? duration,
      reservationDurationMinutes: duration,
      availabilityEngineVersion: result.meta?.engineVersion ?? 3,
    };

    res.json({
      slots: result.slots,
      durationMinutes: duration,
      meta,
      reason: result.reason,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/restaurant/:restaurantId/availability/preview
 *
 * Genera una vista previa de cupos usando config tentativa (sin guardar en DB).
 * Usa slotEngine v3 con los datos que el restaurante envía en el body.
 * No requiere que la config esté guardada → el restaurante puede ver el impacto antes de guardar.
 */
router.post('/availability/preview', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const {
      date,
      partySize = 2,
      defaults,
      durationRules,
      reservationWindows,
      reservationWindowMode,
      pacingRules,
    } = req.body;

    if (!date || typeof date !== 'string') {
      throw new ValidationError('Se requiere date (YYYY-MM-DD)');
    }

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { organization: { include: { owner: { select: { country: true } } } } },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const { previewAvailabilityFromConfig, ENGINE_VERSION } = require('../services/slotEngine/index');

    const result = await previewAvailabilityFromConfig(restaurant, timezone, {
      dateStr: date,
      partySize: size,
      overrides: {
        defaults,
        durationRules,
        reservationWindows,
        reservationWindowMode,
        pacingRules,
      },
    });

    res.json({
      slots: result.slots,
      reason: result.reason,
      engineVersion: ENGINE_VERSION,
    });
  } catch (err) {
    next(err);
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

    const { isCrossMidnightEnabled } = require('../lib/featureFlags');

    if (date) {
      const start = parseInTimezone(date, '00:00', timezone);
      const end = parseInTimezone(date, '23:59', timezone);
      const businessDateVal = new Date(`${date}T12:00:00.000Z`);
      if (isCrossMidnightEnabled()) {
        where.OR = [
          { businessDate: businessDateVal },
          { businessDate: null, dateTime: { gte: start, lte: end } },
        ];
      } else {
        where.dateTime = { gte: start, lte: end };
      }
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

router.get('/reservations/:id', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const reservation = await prisma.reservation.findFirst({
      where: { id: req.params.id, restaurantId },
      include: { table: { select: { id: true, label: true } } },
    });
    if (!reservation) {
      throw new NotFoundError('Reserva no encontrada');
    }
    res.json(reservation);
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

    const dayOfWeek = getDayOfWeekInTimezone(date, timezone);
    const now = nowInTimezone(timezone).toJSDate();

    const reservation = await withSerializableRetry(() =>
      prisma.$transaction(async (tx) => {
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

        const [durationRules, customWindows, blockedSlot, allTables, activeHolds, pacingRules] =
          await Promise.all([
            tx.durationRule.findMany({ where: { restaurantId } }),
            restaurant.reservationWindowMode === 'custom'
              ? tx.reservationWindow.findMany({
                  where: { restaurantId, dayOfWeek },
                  orderBy: { sortOrder: 'asc' },
                })
              : [],
            tx.blockedSlot.findFirst({
              where: {
                restaurantId,
                startDatetime: { lt: new Date(dateTime.getTime() + 4 * 60 * 60000) },
                endDatetime: { gt: dateTime },
              },
            }),
            tx.restaurantTable.findMany({
              where: { isActive: true, zone: { restaurantId, isActive: true } },
              include: { zone: { select: { id: true, sortOrder: true } } },
            }),
            restaurant.holdsEnabled
              ? tx.reservationHold.findMany({
                  where: {
                    restaurantId,
                    status: 'active',
                    expiresAt: { gt: now },
                    dateTime: {
                      gte: new Date(dateTime.getTime() - 4 * 60 * 60000),
                      lte: new Date(dateTime.getTime() + 4 * 60 * 60000),
                    },
                  },
                  select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
                })
              : [],
            tx.pacingRule.findMany({ where: { restaurantId } }),
          ]);

        if (blockedSlot) {
          throw new ValidationError('Este horario está bloqueado' + (blockedSlot.reason ? ': ' + blockedSlot.reason : ''));
        }

        const tables = allTables.map((t) => ({
          id: t.id, zoneId: t.zone.id, minCapacity: t.minCapacity, maxCapacity: t.maxCapacity,
          sortOrder: t.sortOrder ?? 0, zoneSortOrder: t.zone.sortOrder ?? 0,
          zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
        }));

        const lb = dayLookbackMs(restaurant.defaultSlotDurationMinutes, durationRules);
        const windowStart = new Date(dateTime.getTime() - lb);
        const windowEnd = parseInTimezone(date, '23:59', timezone);
        const dayReservations = await tx.reservation.findMany({
          where: { restaurantId, status: 'confirmed', dateTime: { gte: windowStart, lte: windowEnd } },
          select: { tableId: true, dateTime: true, durationMinutes: true },
        });

        const reservationsRaw = dayReservations.map((r) => ({
          tableId: r.tableId, startUtc: r.dateTime.toISOString(), durationMinutes: r.durationMinutes,
        }));
        const holdsRaw = activeHolds.map((h) => ({
          tableId: h.tableId, startUtc: h.dateTime.toISOString(), durationMinutes: h.durationMinutes, holdToken: h.holdToken,
        }));

        const slotDuration = resolveDuration(restaurant, size, durationRules);
        const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);

        let selectedTable = null;

        if (tableId) {
          // Reserva manual con mesa explícita — chequear conflicto vía slotEngine
          const table = await tx.restaurantTable.findUnique({ where: { id: tableId }, include: { zone: true } });
          if (!table || table.zone.restaurantId !== restaurantId) throw new ValidationError('Mesa no válida');
          if (table.minCapacity > size || table.maxCapacity < size) throw new ValidationError('La mesa no admite este número de comensales');
          const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
          const parsedRes = parseReservations(reservationsRaw);
          const parsedHoldsArr = parseHolds(holdsRaw);
          // Verificar conflicto en la mesa específica
          const { countFreeTables } = require('../services/slotEngine/capacity');
          const specificFree = countFreeTables(
            [{ id: table.id, zoneId: table.zone.id, minCapacity: table.minCapacity, maxCapacity: table.maxCapacity }],
            dateTime, slotEnd, bufferMs, parsedRes, parsedHoldsArr, null
          );
          if (specificFree === 0) throw new ValidationError('Esa mesa ya está reservada en ese horario. Elige otra mesa o cambia la hora.');
          selectedTable = table;
        } else {
          // Walk-in u otro: usar slotEngine para validar y asignar (walk-in bypasea grid/notice)
          if (!isWalkIn) {
            const validation = validateSlotForBooking({
              time,
              partySize: size,
              schedule: { ...schedule, scheduleMode: restaurant.scheduleMode },
              restaurant,
              durationRules,
              customWindows,
              tables,
              reservations: reservationsRaw,
              activeHolds: holdsRaw,
              blockedSlots: [],
              pacingRules: pacingRules.map((p) => ({ dayOfWeek: p.dayOfWeek, maxCoversPerSlot: p.maxCoversPerSlot, maxReservationsPerSlot: p.maxReservationsPerSlot })),
              slotDateTime: dateTime,
              now,
              isToday: date === nowInTimezone(timezone).toFormat('yyyy-MM-dd'),
              walkIn: false,
              zoneId: null,
              excludeHoldToken: null,
              dayOfWeek,
            });
            if (!validation.valid) {
              throw new ValidationError(
                validation.reason === 'blocked' ? 'Este horario está bloqueado' :
                validation.reason === 'party_size_exceeds_largest_table' ? 'No hay mesas para este número de comensales' :
                'La hora solicitada no está disponible'
              );
            }
          }

          const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
          selectedTable = pickTable(tables, size, dateTime, slotEnd, bufferMs,
            parseReservations(reservationsRaw), parseHolds(holdsRaw), null, null);
          if (!selectedTable) throw new ValidationError('No hay mesas disponibles en este horario');
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
            notes: isWalkIn ? (typeof notes === 'string' && notes.trim() ? notes.trim() : 'Walk-in') : notes?.trim() || null,
            source: 'manual',
            ...(req.user?.id && { confirmedByUserId: req.user.id, updatedByUserId: req.user.id }),
          },
          include: {
            restaurant: { select: { name: true } },
            table: { select: { id: true, label: true } },
          },
        });
      }, { isolationLevel: 'Serializable' })
    );

    if (!isWalkIn) {
      canSendConfirmations(restaurantId).then((ok) => {
        if (!ok) return;
        if (reservation.customerPhone) {
          sendReservationConfirmation({
            customerPhone: reservation.customerPhone,
            restaurantName: restaurant.name,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
            restaurantId,
          }).catch((err) => console.error('[Notification] Confirmation failed:', err));
        }
        if (reservation.customerEmail) {
          sendReservationConfirmationEmail({
            customerEmail: reservation.customerEmail,
            restaurantName: restaurant.name,
            customerName: name,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
            timezone,
          })
            .then((sent) => {
              if (sent) {
                prisma.reservation
                  .update({ where: { id: reservation.id }, data: { emailSent: true } })
                  .catch((err) => console.error('[Notification] emailSent update failed:', err));
              }
            })
            .catch((err) => console.error('[Notification] Email confirmation failed:', err));
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

    const isHost = req.activeRestaurant.role === ROLES.HOST;

    if (isHost) {
      const windowCheck = assertHostReservationEditWindow(reservation.dateTime);
      if (!windowCheck.allowed) {
        throw new ForbiddenError(windowCheck.message);
      }
      if (partySize !== undefined) {
        const partyCheck = assertHostPartySizeIncrease(
          reservation.partySize,
          parseInt(partySize, 10),
        );
        if (!partyCheck.allowed) {
          throw new ForbiddenError(partyCheck.message);
        }
      }
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

      if (isHost) {
        const newWindowCheck = assertHostReservationEditWindow(dateTime);
        if (!newWindowCheck.allowed) {
          throw new ForbiddenError(newWindowCheck.message);
        }
      }

      const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);
      const now = nowInTimezone(timezone).toJSDate();

      const updated = await withSerializableRetry(() =>
        prisma.$transaction(async (tx) => {
          const schedule = await tx.schedule.findFirst({
            where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
          });
          if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

          const [durationRules, customWindows, blockedSlot, allTables, activeHolds, pacingRules] =
            await Promise.all([
              tx.durationRule.findMany({ where: { restaurantId: restaurant.id } }),
              restaurant.reservationWindowMode === 'custom'
                ? tx.reservationWindow.findMany({
                    where: { restaurantId: restaurant.id, dayOfWeek },
                    orderBy: { sortOrder: 'asc' },
                  })
                : [],
              tx.blockedSlot.findFirst({
                where: {
                  restaurantId: restaurant.id,
                  startDatetime: { lt: new Date(dateTime.getTime() + 4 * 60 * 60000) },
                  endDatetime: { gt: dateTime },
                },
              }),
              tx.restaurantTable.findMany({
                where: { isActive: true, zone: { restaurantId: restaurant.id, isActive: true } },
                include: { zone: { select: { id: true, sortOrder: true } } },
              }),
              restaurant.holdsEnabled
                ? tx.reservationHold.findMany({
                    where: {
                      restaurantId: restaurant.id,
                      status: 'active',
                      expiresAt: { gt: now },
                      dateTime: {
                        gte: new Date(dateTime.getTime() - 4 * 60 * 60000),
                        lte: new Date(dateTime.getTime() + 4 * 60 * 60000),
                      },
                    },
                    select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
                  })
                : [],
              tx.pacingRule.findMany({ where: { restaurantId: restaurant.id } }),
            ]);

          if (blockedSlot) {
            throw new ValidationError('Este horario está bloqueado' + (blockedSlot.reason ? ': ' + blockedSlot.reason : ''));
          }

          const tables = allTables.map((t) => ({
            id: t.id, zoneId: t.zone.id, minCapacity: t.minCapacity, maxCapacity: t.maxCapacity,
            sortOrder: t.sortOrder ?? 0, zoneSortOrder: t.zone.sortOrder ?? 0,
            zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
          }));

          const lb = dayLookbackMs(restaurant.defaultSlotDurationMinutes, durationRules);
          const windowStart = new Date(dateTime.getTime() - lb);
          const windowEnd = parseInTimezone(dateStr, '23:59', timezone);
          const dayReservations = await tx.reservation.findMany({
            where: {
              restaurantId: restaurant.id, status: 'confirmed',
              dateTime: { gte: windowStart, lte: windowEnd },
              id: { not: reservation.id },
            },
            select: { tableId: true, dateTime: true, durationMinutes: true },
          });

          const slotDuration = resolveDuration(restaurant, size, durationRules);
          const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
          const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;

          const reservationsRaw = dayReservations.map((r) => ({
            tableId: r.tableId, startUtc: r.dateTime.toISOString(), durationMinutes: r.durationMinutes,
          }));
          const holdsRaw = activeHolds.map((h) => ({
            tableId: h.tableId, startUtc: h.dateTime.toISOString(), durationMinutes: h.durationMinutes, holdToken: h.holdToken,
          }));

          let tableIdVal = tableId;
          if (tableId != null && typeof tableId === 'object' && 'value' in tableId) tableIdVal = tableId.value;
          const tableIdStr = (tableIdVal != null && String(tableIdVal).trim()) || null;

          let selectedTable = null;
          if (tableIdStr) {
            const table = await tx.restaurantTable.findUnique({ where: { id: tableIdStr }, include: { zone: true } });
            if (!table || table.zone.restaurantId !== restaurant.id) throw new ValidationError('Mesa no válida');
            if (table.minCapacity > size || table.maxCapacity < size) throw new ValidationError('La mesa no admite este número de comensales');
            const { countFreeTables } = require('../services/slotEngine/capacity');
            const specificFree = countFreeTables(
              [{ id: table.id, zoneId: table.zone.id, minCapacity: table.minCapacity, maxCapacity: table.maxCapacity }],
              dateTime, slotEnd, bufferMs, parseReservations(reservationsRaw), parseHolds(holdsRaw), null
            );
            if (specificFree === 0) throw new ValidationError('Esa mesa ya tiene una reserva en ese horario. Elige otra mesa o cambia la hora.');
            selectedTable = table;
          } else {
            selectedTable = pickTable(tables, size, dateTime, slotEnd, bufferMs,
              parseReservations(reservationsRaw), parseHolds(holdsRaw), null, null);
            if (!selectedTable) throw new ValidationError('No hay mesas disponibles en este horario');
          }

          return tx.reservation.update({
            where: { id: req.params.id },
            data: {
              dateTime,
              partySize: size,
              tableId: selectedTable.id,
              durationMinutes: slotDuration,
              ...(notes !== undefined && { notes: notes === '' ? null : String(notes).trim() || null }),
              ...(req.user?.id && { updatedByUserId: req.user.id }),
            },
            include: {
              restaurant: { select: { name: true } },
              table: { select: { id: true, label: true } },
            },
          });
        }, { isolationLevel: 'Serializable' })
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

    const actorId = req.user?.id ?? null;
    const statusData = { status };
    if (actorId) {
      statusData.updatedByUserId = actorId;
      if (status === 'confirmed') {
        statusData.confirmedByUserId = actorId;
      }
    }

    const updated = await prisma.reservation.update({
      where: { id: req.params.id },
      data: statusData,
      include: {
        restaurant: { select: { id: true, name: true } },
      },
    });

    const { syncFeedbackOnReservationStatusChange } = require('../services/feedbackEngine');
    syncFeedbackOnReservationStatusChange(updated, status).catch(() => {});

    if (status === 'cancelled') {
      writeAuditLog({
        actorUserId: req.user?.id ?? null,
        restaurantId: reservation.restaurantId,
        action: 'reservation.cancel',
        resourceType: 'reservation',
        resourceId: reservation.id,
        metadata: { status },
      }).catch(() => {});
    }

    incrementDataVersion(reservation.restaurantId).catch(console.error);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// --- Blocked Slots sub-routes (config; hosts excluded) ---

router.get('/blocked-slots', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
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

router.post('/blocked-slots', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
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

router.delete('/blocked-slots/:id', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
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
