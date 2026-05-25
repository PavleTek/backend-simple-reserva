'use strict';

const { DateTime } = require('luxon');
const { nowInTimezone } = require('../../utils/timezone');
const { timeToMinutes, getOperatingWindows, wrapWindow } = require('../slotEngine/windows');
const { isBookingAcceptanceEnabled } = require('../../lib/featureFlags');

/**
 * @param {string} mode - ALWAYS_24_7 | DURING_OPERATIONAL | CUSTOM
 * @param {Array} schedules - active schedules
 * @param {Array} acceptanceWindows - BookingAcceptanceWindow rows
 * @param {number} dayOfWeek - 0..6
 * @param {string} scheduleMode
 * @returns {Array<[number, number]>}
 */
function computeAcceptanceWindowsForDay(mode, schedules, acceptanceWindows, dayOfWeek, scheduleMode) {
  if (!isBookingAcceptanceEnabled() || mode === 'ALWAYS_24_7') {
    return [[0, 1440]];
  }

  if (mode === 'DURING_OPERATIONAL') {
    const sched = schedules.find((s) => s.dayOfWeek === dayOfWeek && s.isActive !== false);
    if (!sched) return [];
    return getOperatingWindows(
      {
        ...sched,
        dayOfWeek: sched.dayOfWeek,
      },
      scheduleMode,
    );
  }

  if (mode === 'CUSTOM') {
    return acceptanceWindows
      .filter((w) => w.isActive !== false && w.dayOfWeek === dayOfWeek)
      .map((w) =>
        wrapWindow(timeToMinutes(w.startTime), timeToMinutes(w.endTime), !!w.endsNextDay),
      )
      .filter(Boolean);
  }

  return [[0, 1440]];
}

function minuteInWindows(minute, windows) {
  return windows.some(([s, e]) => minute >= s && minute < e);
}

/**
 * Checks if a minute falls in yesterday's window extended past midnight.
 */
function minuteInYesterdayTail(minute, yesterdayWindows) {
  for (const [s, e] of yesterdayWindows) {
    if (e > 1440 && minute < e - 1440) {
      if (minute + 1440 >= s) return true;
    }
  }
  return false;
}

/**
 * @returns {{ open: boolean; nextOpenAt?: string; reason?: string }}
 */
function isAcceptingBookingsNow(restaurant, schedules, acceptanceWindows, timezone, now = new Date()) {
  const mode = restaurant.bookingAcceptanceMode ?? 'ALWAYS_24_7';
  if (!isBookingAcceptanceEnabled() || mode === 'ALWAYS_24_7') {
    return { open: true };
  }

  const scheduleMode = restaurant.scheduleMode ?? 'continuous';
  const nowDt = DateTime.fromJSDate(now).setZone(timezone);
  const dow = nowDt.weekday === 7 ? 0 : nowDt.weekday;
  const nowMin = nowDt.hour * 60 + nowDt.minute;

  const todayWindows = computeAcceptanceWindowsForDay(
    mode,
    schedules,
    acceptanceWindows,
    dow,
    scheduleMode,
  );

  if (minuteInWindows(nowMin, todayWindows)) {
    return { open: true };
  }

  const yesterdayDow = dow === 0 ? 6 : dow - 1;
  const yesterdayWindows = computeAcceptanceWindowsForDay(
    mode,
    schedules,
    acceptanceWindows,
    yesterdayDow,
    scheduleMode,
  );

  if (minuteInYesterdayTail(nowMin, yesterdayWindows)) {
    return { open: true };
  }

  const nextOpen = findNextOpenAt(restaurant, schedules, acceptanceWindows, timezone, nowDt);
  return { open: false, nextOpenAt: nextOpen, reason: 'booking_closed' };
}

function findNextOpenAt(restaurant, schedules, acceptanceWindows, timezone, fromDt) {
  const mode = restaurant.bookingAcceptanceMode ?? 'ALWAYS_24_7';
  const scheduleMode = restaurant.scheduleMode ?? 'continuous';

  for (let d = 0; d < 8; d++) {
    const dt = fromDt.plus({ days: d });
    const dow = dt.weekday === 7 ? 0 : dt.weekday;
    const windows = computeAcceptanceWindowsForDay(
      mode,
      schedules,
      acceptanceWindows,
      dow,
      scheduleMode,
    );
    for (const [s] of windows) {
      const openDt = dt.startOf('day').plus({ minutes: s % 1440 });
      if (openDt > fromDt) {
        return openDt.toISO();
      }
    }
  }
  return null;
}

/**
 * Public booking status payload for GET /booking-status
 */
function getBookingStatusPayload(restaurant, schedules, acceptanceWindows, timezone) {
  const result = isAcceptingBookingsNow(restaurant, schedules, acceptanceWindows, timezone);
  return {
    acceptingBookings: result.open,
    bookingAcceptanceMode: restaurant.bookingAcceptanceMode ?? 'ALWAYS_24_7',
    fallback: restaurant.bookingClosedFallback ?? 'MESSAGE',
    message: restaurant.bookingClosedMessage ?? null,
    contact: {
      phone: restaurant.bookingContactPhone ?? null,
      whatsapp: restaurant.bookingContactWhatsapp ?? null,
      email: restaurant.bookingContactEmail ?? null,
    },
    nextOpenAt: result.nextOpenAt ?? null,
    reason: result.reason ?? null,
  };
}

module.exports = {
  computeAcceptanceWindowsForDay,
  isAcceptingBookingsNow,
  getBookingStatusPayload,
};
