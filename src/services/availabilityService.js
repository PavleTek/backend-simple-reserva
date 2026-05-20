const prisma = require('../lib/prisma');
const {
  AVAILABILITY_ENGINE_VERSION,
  resolveEffectiveSlotMode,
  resolveDuration,
  generateTimeSlots,
  compareEngines,
  maybeLogShadowCompare,
} = require('./reservationSlotService');
const { isShadowSlotEngineEnabled } = require('../lib/slotEngineFlags');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  getDayOfWeekInTimezone,
} = require('../utils/timezone');
const { hasActiveAccess } = require('../services/subscriptionService');
const { DateTime } = require('luxon');

/**
 * Loads all data needed to compute slot availability for a restaurant on a given calendar day.
 */
async function loadDaySnapshot(restaurant, { dateStr, timezone }) {
  const dayStart = parseInTimezone(dateStr, '00:00', timezone);
  const windowStart = new Date(dayStart.getTime() - 12 * 60 * 60000);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

  const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);
  const effectiveMode = resolveEffectiveSlotMode(restaurant);

  const [
    schedule,
    allTables,
    allZones,
    durationRules,
    blockedSlots,
    reservations,
    reservationWindows,
  ] = await Promise.all([
    prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    }),
    prisma.restaurantTable.findMany({
      where: {
        isActive: true,
        zone: { restaurantId: restaurant.id, isActive: true },
      },
      include: { zone: { select: { id: true, sortOrder: true } } },
      orderBy: { maxCapacity: 'asc' },
    }),
    prisma.zone.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, sortOrder: true, smokingZone: true },
    }),
    prisma.durationRule.findMany({ where: { restaurantId: restaurant.id } }),
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
        status: 'confirmed',
        dateTime: { gte: windowStart, lte: dayEnd },
      },
      select: { tableId: true, dateTime: true, durationMinutes: true },
    }),
    prisma.reservationWindow.findMany({
      where: { restaurantId: restaurant.id, dayOfWeek },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  const serverNow = nowInTimezone(timezone).toJSDate();
  const todayLocal = nowInTimezone(timezone).toFormat('yyyy-MM-dd');

  return {
    restaurantId: restaurant.id,
    date: dateStr,
    timezone,
    schedule: schedule
      ? {
          dayOfWeek: schedule.dayOfWeek,
          scheduleMode: restaurant.scheduleMode,
          openTime: schedule.openTime,
          closeTime: schedule.closeTime,
          breakfastStartTime: schedule.breakfastStartTime ?? null,
          breakfastEndTime: schedule.breakfastEndTime ?? null,
          lunchStartTime: schedule.lunchStartTime ?? null,
          lunchEndTime: schedule.lunchEndTime ?? null,
          dinnerStartTime: schedule.dinnerStartTime ?? null,
          dinnerEndTime: schedule.dinnerEndTime ?? null,
        }
      : null,
    defaults: {
      availabilityEngineVersion: AVAILABILITY_ENGINE_VERSION,
      slotDurationMinutes: restaurant.defaultSlotDurationMinutes,
      slotIntervalMinutes: restaurant.slotIntervalMinutes ?? restaurant.defaultSlotDurationMinutes,
      slotGenerationMode: restaurant.slotGenerationMode ?? 'legacy',
      effectiveSlotGenerationMode: effectiveMode,
      reservationEndPolicy: restaurant.reservationEndPolicy ?? 'STRICT_END',
      reservationWindowMode: restaurant.reservationWindowMode ?? 'same_as_schedule',
      bufferMinutesBetweenReservations: restaurant.bufferMinutesBetweenReservations ?? 0,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes ?? 60,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays ?? 30,
    },
    reservationWindows: reservationWindows.map((w) => ({
      dayOfWeek: w.dayOfWeek,
      startTime: w.startTime,
      endTime: w.endTime,
      label: w.label,
      sortOrder: w.sortOrder,
    })),
    durationRules: durationRules.map((r) => ({
      minPartySize: r.minPartySize,
      maxPartySize: r.maxPartySize,
      durationMinutes: r.durationMinutes,
    })),
    tables: allTables.map((t) => ({
      id: t.id,
      zoneId: t.zone.id,
      minCapacity: t.minCapacity,
      maxCapacity: t.maxCapacity,
      sortOrder: t.sortOrder ?? 0,
      zoneSortOrder: t.zone.sortOrder ?? 0,
    })),
    zones: allZones,
    blockedSlots: blockedSlots.map((bs) => ({
      startUtc: bs.startDatetime.toISOString(),
      endUtc: bs.endDatetime.toISOString(),
    })),
    reservations: reservations.map((r) => ({
      tableId: r.tableId,
      startUtc: r.dateTime.toISOString(),
      durationMinutes: r.durationMinutes,
    })),
    serverNowUtc: serverNow.toISOString(),
    isToday: dateStr === todayLocal,
  };
}

/**
 * Pure availability computation from a day snapshot.
 * @param {{ walkIn?: boolean }} options
 */
function computeAvailability(snapshot, { partySize, zoneId, now, walkIn = false }) {
  const {
    schedule,
    defaults,
    durationRules,
    tables,
    blockedSlots,
    reservations,
    reservationWindows,
    isToday,
    timezone,
    date,
    restaurantId,
  } = snapshot;

  if (!schedule) return { slots: [], reason: 'no_schedule' };

  const candidateTables = tables.filter(
    (t) =>
      t.minCapacity <= partySize &&
      t.maxCapacity >= partySize &&
      (!zoneId || t.zoneId === zoneId)
  );
  if (candidateTables.length === 0) return { slots: [], reason: 'no_tables' };

  const restaurantLike = {
    defaultSlotDurationMinutes: defaults.slotDurationMinutes,
    slotIntervalMinutes: defaults.slotIntervalMinutes,
    slotGenerationMode: defaults.slotGenerationMode,
    reservationEndPolicy: defaults.reservationEndPolicy,
    reservationWindowMode: defaults.reservationWindowMode,
  };

  const duration = resolveDuration(restaurantLike, partySize, durationRules);
  const mode = defaults.effectiveSlotGenerationMode ?? 'legacy';
  const intervalMinutes =
    mode === 'clock_aligned' ? defaults.slotIntervalMinutes : duration;

  const slotGenParams = {
    mode,
    schedule,
    scheduleMode: schedule.scheduleMode,
    intervalMinutes,
    reservationDurationMinutes: duration,
    reservationEndPolicy: defaults.reservationEndPolicy,
    reservationWindowMode: defaults.reservationWindowMode,
    customWindows: reservationWindows ?? [],
  };

  if (isShadowSlotEngineEnabled()) {
    const shadow = compareEngines(slotGenParams);
    maybeLogShadowCompare(
      { restaurantId, date, partySize, mode },
      shadow
    );
  }

  const slotDefs = generateTimeSlots(slotGenParams);
  if (slotDefs.length === 0) return { slots: [], reason: 'no_slots' };

  const timeSlots = slotDefs.map(({ time }) => {
    const start = parseInTimezone(date, time, timezone);
    const end = new Date(start.getTime() + duration * 60000);
    return { time, start, end };
  });

  const nowDate = now instanceof Date ? now : new Date(snapshot.serverNowUtc);
  const minNotice = defaults.minimumNoticeMinutes;
  const minSlotTime = isToday
    ? walkIn
      ? nowDate
      : new Date(nowDate.getTime() + minNotice * 60000)
    : null;
  const minSlotMinute = minSlotTime ? Math.floor(minSlotTime.getTime() / 60000) : null;

  const parsedBlocked = blockedSlots.map((bs) => ({
    start: new Date(bs.startUtc),
    end: new Date(bs.endUtc),
  }));
  const bufferMs = defaults.bufferMinutesBetweenReservations * 60000;
  const parsedReservations = reservations.map((r) => ({
    tableId: r.tableId,
    start: new Date(r.startUtc),
    end: new Date(new Date(r.startUtc).getTime() + r.durationMinutes * 60000),
  }));

  const available = [];
  for (const slot of timeSlots) {
    if (isToday && minSlotMinute != null) {
      const slotMinute = Math.floor(slot.start.getTime() / 60000);
      if (slotMinute < minSlotMinute) continue;
    }

    const isBlocked = parsedBlocked.some(
      (bs) => slot.start < bs.end && slot.end > bs.start
    );
    if (isBlocked) continue;

    let openTables = 0;
    for (const table of candidateTables) {
      const booked = parsedReservations.some((r) => {
        if (r.tableId !== table.id) return false;
        const rEnd = new Date(r.end.getTime() + bufferMs);
        return slot.start < rEnd && slot.end > r.start;
      });
      if (!booked) openTables++;
    }

    if (openTables > 0) {
      available.push({ time: slot.time, available: true, availableTables: openTables });
    }
  }

  if (available.length === 0) return { slots: [], reason: 'no_availability' };
  return {
    slots: available,
    meta: {
      availabilityEngineVersion: defaults.availabilityEngineVersion,
      slotGenerationMode: mode,
      slotStepMinutes: intervalMinutes,
      reservationDurationMinutes: duration,
    },
  };
}

async function getAvailabilitySlotsForRestaurant(restaurant, { dateStr, partySize, zoneId, timezone, walkIn }) {
  const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
  return computeAvailability(snapshot, {
    partySize,
    zoneId: zoneId || null,
    now: new Date(snapshot.serverNowUtc),
    walkIn: !!walkIn,
  });
}

async function findNextAvailableDateForSlug(slug, { fromDateStr, partySize, zoneId }) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true, isDeleted: false },
    include: {
      organization: { include: { owner: { select: { country: true } } } },
    },
  });
  if (!restaurant) {
    return { ok: false, error: 'not_found' };
  }
  const access = await hasActiveAccess(restaurant.organizationId);
  if (!access) {
    return { ok: true, nextDate: null, reason: 'subscription_expired' };
  }

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const advanceDays = restaurant.advanceBookingLimitDays ?? 30;

  let cursor = DateTime.fromISO(fromDateStr, { zone: timezone }).plus({ days: 1 });
  const limitEnd = DateTime.now().setZone(timezone).plus({ days: advanceDays });

  while (cursor.startOf('day') <= limitEnd.endOf('day')) {
    const dateStr = cursor.toFormat('yyyy-MM-dd');
    const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
    const result = computeAvailability(snapshot, {
      partySize,
      zoneId: zoneId || null,
      now: new Date(snapshot.serverNowUtc),
    });
    if (result.slots.length > 0) {
      return { ok: true, nextDate: dateStr, slotsCount: result.slots.length };
    }
    cursor = cursor.plus({ days: 1 });
  }

  return { ok: true, nextDate: null, reason: 'no_future_availability' };
}

module.exports = {
  loadDaySnapshot,
  computeAvailability,
  getAvailabilitySlotsForRestaurant,
  findNextAvailableDateForSlug,
};
