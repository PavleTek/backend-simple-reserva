const prisma = require('../lib/prisma');
const { generateTimeSlots, resolveDuration } = require('../utils/scheduleUtils');
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
 *
 * Returns a "day snapshot" object that is party-size and zone agnostic.
 * Pass it to computeAvailability() to derive available slots for any (partySize, zoneId) pair
 * without making additional DB calls.
 *
 * @param {Object} restaurant - Prisma restaurant record (must include organizationId and scheduling fields)
 * @param {{ dateStr: string, timezone: string }} options
 */
async function loadDaySnapshot(restaurant, { dateStr, timezone }) {
  const dayStart = parseInTimezone(dateStr, '00:00', timezone);
  // Extend look-back 12 h so long reservations starting the previous evening aren't missed
  const windowStart = new Date(dayStart.getTime() - 12 * 60 * 60000);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

  // CRITICAL: compute day-of-week in the RESTAURANT's timezone, not the server's.
  // Using dayStart.getDay() would silently fail when the server runs in a different
  // timezone than the restaurant (e.g. UTC server + Santiago restaurant on a Saturday
  // could return Friday because Santiago Saturday 00:00 is Friday evening UTC-or-EST).
  const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);

  const [schedule, allTables, allZones, durationRules, blockedSlots, reservations] =
    await Promise.all([
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
        select: { id: true, name: true, sortOrder: true },
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
    ]);

  const serverNow = nowInTimezone(timezone).toJSDate();
  const todayLocal = nowInTimezone(timezone).toFormat('yyyy-MM-dd');

  return {
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
      slotDurationMinutes: restaurant.defaultSlotDurationMinutes,
      bufferMinutesBetweenReservations: restaurant.bufferMinutesBetweenReservations ?? 0,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes ?? 60,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays ?? 30,
    },
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
 * Pure, synchronous availability computation: given a day snapshot, returns available time
 * slots for the specified partySize / zoneId.  No DB calls — safe to call in a hot loop.
 *
 * Mirrors frontend computeSlots() in user-front-simple-reserva/src/lib/availability.ts.
 * Both must stay in sync.
 *
 * @param {ReturnType<loadDaySnapshot> extends Promise<infer R> ? R : never} snapshot
 * @param {{ partySize: number, zoneId?: string|null, now?: Date }} options
 * @returns {{ slots: Array<{time:string,available:boolean,availableTables:number}>, reason?: string }}
 */
function computeAvailability(snapshot, { partySize, zoneId, now }) {
  const { schedule, defaults, durationRules, tables, blockedSlots, reservations, isToday, timezone, date } =
    snapshot;

  if (!schedule) return { slots: [], reason: 'no_schedule' };

  const candidateTables = tables.filter(
    (t) =>
      t.minCapacity <= partySize &&
      t.maxCapacity >= partySize &&
      (!zoneId || t.zoneId === zoneId)
  );
  if (candidateTables.length === 0) return { slots: [], reason: 'no_tables' };

  const duration = resolveDuration(
    { defaultSlotDurationMinutes: defaults.slotDurationMinutes },
    partySize,
    durationRules
  );

  const slotDefs = generateTimeSlots(schedule, duration, schedule.scheduleMode);
  if (slotDefs.length === 0) return { slots: [], reason: 'no_slots' };

  const timeSlots = slotDefs.map(({ time }) => {
    const start = parseInTimezone(date, time, timezone);
    const end = new Date(start.getTime() + duration * 60000);
    return { time, start, end };
  });

  const nowDate = now instanceof Date ? now : new Date(snapshot.serverNowUtc);
  const minNotice = defaults.minimumNoticeMinutes;
  const minSlotTime = isToday ? new Date(nowDate.getTime() + minNotice * 60000) : null;
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
  return { slots: available };
}

/**
 * Computes available time slots for a restaurant on a calendar date.
 * Kept for backward-compatibility; internally delegates to loadDaySnapshot + computeAvailability.
 *
 * @returns {{ slots: Array<{time: string, available: boolean, availableTables?: number}>, reason?: string }}
 */
async function getAvailabilitySlotsForRestaurant(restaurant, { dateStr, partySize, zoneId, timezone }) {
  const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
  return computeAvailability(snapshot, {
    partySize,
    zoneId: zoneId || null,
    now: new Date(snapshot.serverNowUtc),
  });
}

/**
 * Finds the next calendar date (strictly after `fromDateStr`) with at least one open slot.
 */
async function findNextAvailableDateForSlug(slug, { fromDateStr, partySize, zoneId }) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true },
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
