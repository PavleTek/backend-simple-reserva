'use strict';

const { getReservationWindows, timeToMinutes } = require('./windows');
const { isOnGrid, timeToGridMinutes } = require('./grid');
const { getScheduleOpenMeta } = require('./businessDate');
const { resolveDuration } = require('./duration');
const { parseBlockedSlots, validateBookingPolicies } = require('./policies');
const { getCandidateTables, countFreeTables, checkPacing, parseReservations, parseHolds } = require('./capacity');

function validateSlotForBooking({
  time,
  partySize,
  schedule,
  restaurant,
  durationRules,
  customWindows = [],
  tables,
  reservations,
  activeHolds,
  blockedSlots,
  pacingRules = [],
  slotDateTime,
  now,
  isToday = false,
  walkIn = false,
  zoneId = null,
  excludeHoldToken = null,
  dayOfWeek,
  blockingSessions = [],
}) {
  if (!schedule) {
    return { valid: false, reason: 'no_schedule' };
  }

  const scheduleMode = schedule.scheduleMode ?? restaurant.scheduleMode ?? 'continuous';
  const reservationWindowMode = restaurant.reservationWindowMode ?? 'same_as_schedule';
  const reservationEndPolicy = restaurant.reservationEndPolicy ?? 'STRICT_END';
  const intervalMinutes = restaurant.slotIntervalMinutes ?? restaurant.defaultSlotDurationMinutes ?? 60;
  const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
  const minimumNoticeMinutes = restaurant.minimumNoticeMinutes ?? 60;
  const advanceBookingLimitDays = restaurant.advanceBookingLimitDays ?? 30;

  const durationMinutes = resolveDuration(restaurant, partySize, durationRules);

  const { openMin, closesNextDay } = getScheduleOpenMeta(schedule, scheduleMode);
  const timeMinWall = timeToMinutes(time);
  const nextDayLeg = closesNextDay && timeMinWall < openMin;
  const timeMin = timeToGridMinutes(time, nextDayLeg);

  const windows = getReservationWindows(schedule, scheduleMode, reservationWindowMode, customWindows);
  if (!isOnGrid(timeMin, windows, intervalMinutes, durationMinutes, reservationEndPolicy)) {
    return { valid: false, reason: 'slot_not_on_grid' };
  }

  const policyCheck = validateBookingPolicies(slotDateTime, now, minimumNoticeMinutes, advanceBookingLimitDays, walkIn);
  if (!policyCheck.valid) {
    return { valid: false, reason: policyCheck.reason };
  }

  const parsedBlocked = parseBlockedSlots(blockedSlots);
  const slotEnd = new Date(slotDateTime.getTime() + durationMinutes * 60000);
  const isBlocked = parsedBlocked.some((bs) => slotDateTime < bs.end && slotEnd > bs.start);
  if (isBlocked) {
    return { valid: false, reason: 'blocked' };
  }

  const parsedRes = parseReservations(reservations);
  const parsedHolds = parseHolds(activeHolds);

  const candidateTables = getCandidateTables(tables, partySize, zoneId);
  if (candidateTables.length === 0) {
    const anyTable = getCandidateTables(tables, partySize, null);
    return {
      valid: false,
      reason: anyTable.length === 0 ? 'party_size_exceeds_largest_table' : 'no_tables_in_zone',
    };
  }

  const freeTables = countFreeTables(
    candidateTables,
    slotDateTime,
    slotEnd,
    bufferMs,
    parsedRes,
    parsedHolds,
    excludeHoldToken,
    blockingSessions
  );
  if (freeTables === 0) {
    return { valid: false, reason: 'no_tables_available' };
  }

  if (pacingRules.length > 0) {
    const slotReservations = parsedRes.filter((r) => slotDateTime < r.end && slotEnd > r.start);
    const slotHolds = parsedHolds.filter((h) => {
      if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
      return slotDateTime < h.end && slotEnd > h.start;
    });
    const confirmedCovers = slotReservations.length + slotHolds.length;
    const confirmedReservations = slotReservations.length + slotHolds.length;
    const dow = dayOfWeek ?? slotDateTime.getDay();
    const pacingCheck = checkPacing(pacingRules, dow, confirmedCovers, confirmedReservations, partySize);
    if (!pacingCheck.ok) {
      return { valid: false, reason: pacingCheck.reason };
    }
  }

  return { valid: true, durationMinutes };
}

module.exports = { validateSlotForBooking };
