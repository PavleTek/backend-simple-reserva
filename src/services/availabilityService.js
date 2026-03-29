const prisma = require('../lib/prisma');
const { generateTimeSlots } = require('../utils/scheduleUtils');
const { getEffectiveTimezone, parseInTimezone, nowInTimezone } = require('../utils/timezone');
const { hasActiveAccess } = require('../services/subscriptionService');
const { DateTime } = require('luxon');

/**
 * Computes available time slots for a restaurant on a calendar date (YYYY-MM-DD in `timezone`).
 * Mirrors public GET /:slug/availability behaviour.
 *
 * @returns {{ slots: Array<{time: string, available: boolean, availableTables?: number}>, reason?: string }}
 */
async function getAvailabilitySlotsForRestaurant(restaurant, { dateStr, partySize, zoneId, timezone }) {
  const size = partySize;
  const dayOfWeek = parseInTimezone(dateStr, '00:00', timezone).getDay();

  const schedule = await prisma.schedule.findFirst({
    where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
  });
  if (!schedule) {
    return { slots: [], reason: 'no_schedule' };
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

  if (!tables.length) return { slots: [], reason: 'no_tables' };

  const duration = restaurant.defaultSlotDurationMinutes;
  const slotDefs = generateTimeSlots(schedule, duration, restaurant.scheduleMode);
  const timeSlots = slotDefs.map(({ time, startMin }) => {
    const start = parseInTimezone(dateStr, time, timezone);
    const end = new Date(start.getTime() + duration * 60000);
    return { time, start, end };
  });
  if (timeSlots.length === 0) return { slots: [], reason: 'no_slots' };

  const dayStart = parseInTimezone(dateStr, '00:00', timezone);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

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
  const isToday = dateStr === todayLocal;
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
        availableTables: openTables,
      });
    }
  }

  if (available.length === 0) {
    return { slots: [], reason: 'no_availability' };
  }
  return { slots: available };
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
    const result = await getAvailabilitySlotsForRestaurant(restaurant, {
      dateStr,
      partySize,
      zoneId: zoneId || null,
      timezone,
    });
    if (result.slots.length > 0) {
      return {
        ok: true,
        nextDate: dateStr,
        slotsCount: result.slots.length,
      };
    }
    cursor = cursor.plus({ days: 1 });
  }

  return { ok: true, nextDate: null, reason: 'no_future_availability' };
}

module.exports = {
  getAvailabilitySlotsForRestaurant,
  findNextAvailableDateForSlug,
};
