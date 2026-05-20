'use strict';

const logger = require('../lib/logger');
const { isClockAlignedEnabled, isShadowSlotEngineEnabled } = require('../lib/slotEngineFlags');

const AVAILABILITY_ENGINE_VERSION = 2;

/**
 * Returns effective slot generation mode (DB + feature flag).
 * @param {{ slotGenerationMode?: string }} restaurant
 */
function resolveEffectiveSlotMode(restaurant) {
  const dbMode = restaurant?.slotGenerationMode === 'clock_aligned' ? 'clock_aligned' : 'legacy';
  if (dbMode === 'clock_aligned' && !isClockAlignedEnabled()) {
    return 'legacy';
  }
  return dbMode;
}

function getOperatingWindows(schedule, scheduleMode = 'continuous') {
  if (!schedule) return [];

  if (scheduleMode === 'service_periods') {
    const windows = [];
    const periods = [
      [schedule.breakfastStartTime, schedule.breakfastEndTime],
      [schedule.lunchStartTime, schedule.lunchEndTime],
      [schedule.dinnerStartTime, schedule.dinnerEndTime],
    ];
    for (const [start, end] of periods) {
      if (start && end) {
        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);
        windows.push([startH * 60 + startM, endH * 60 + endM]);
      }
    }
    return windows;
  }

  const openTime = schedule.openTime ?? '00:00';
  const closeTime = schedule.closeTime ?? '23:59';
  const [openH, openM] = openTime.split(':').map(Number);
  const [closeH, closeM] = closeTime.split(':').map(Number);
  return [[openH * 60 + openM, closeH * 60 + closeM]];
}

/**
 * Ventanas donde se generan cupos de reserva.
 * @param {Array<{ startTime: string, endTime: string }>} [customWindows]
 */
function getReservationWindows(
  schedule,
  scheduleMode,
  reservationWindowMode = 'same_as_schedule',
  customWindows = []
) {
  if (
    reservationWindowMode === 'custom' &&
    Array.isArray(customWindows) &&
    customWindows.length > 0
  ) {
    const windows = [];
    for (const w of customWindows) {
      if (!w.startTime || !w.endTime) continue;
      const [sh, sm] = w.startTime.split(':').map(Number);
      const [eh, em] = w.endTime.split(':').map(Number);
      if (sh * 60 + sm < eh * 60 + em) {
        windows.push([sh * 60 + sm, eh * 60 + em]);
      }
    }
    return windows;
  }
  return getOperatingWindows(schedule, scheduleMode);
}

/** Primer minuto local >= minute alineado al reloj (interval en minutos desde medianoche). */
function alignToGrid(minute, intervalMinutes) {
  if (intervalMinutes <= 0) return minute;
  const remainder = minute % intervalMinutes;
  return remainder === 0 ? minute : minute + (intervalMinutes - remainder);
}

function slotFitsWindow(startMin, reservationDuration, windowEnd, reservationEndPolicy) {
  if (reservationEndPolicy === 'ALLOW_OVERFLOW') {
    return startMin < windowEnd;
  }
  return startMin + reservationDuration <= windowEnd;
}

function generateTimeSlotsLegacy(windows, reservationDurationMinutes, reservationEndPolicy = 'STRICT_END') {
  const slots = [];
  const step = reservationDurationMinutes;
  for (const [startMin, endMin] of windows) {
    for (let m = startMin; slotFitsWindow(m, reservationDurationMinutes, endMin, reservationEndPolicy); m += step) {
      const time = minutesToTime(m);
      slots.push({ time, startMin: m, endMin: m + reservationDurationMinutes });
    }
  }
  return slots;
}

function generateTimeSlotsClockAligned(
  windows,
  intervalMinutes,
  reservationDurationMinutes,
  reservationEndPolicy = 'STRICT_END'
) {
  const slots = [];
  const interval = Math.max(5, intervalMinutes);
  for (const [startMin, endMin] of windows) {
    let m = alignToGrid(startMin, interval);
    while (slotFitsWindow(m, reservationDurationMinutes, endMin, reservationEndPolicy)) {
      const time = minutesToTime(m);
      slots.push({ time, startMin: m, endMin: m + reservationDurationMinutes });
      m += interval;
    }
  }
  return slots;
}

function minutesToTime(m) {
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * @param {object} options
 * @param {'legacy'|'clock_aligned'} options.mode
 */
function generateTimeSlots(options) {
  const {
    mode,
    schedule,
    scheduleMode = 'continuous',
    windows: windowsOverride,
    intervalMinutes = 60,
    reservationDurationMinutes,
    reservationEndPolicy = 'STRICT_END',
    reservationWindowMode = 'same_as_schedule',
    customWindows = [],
  } = options;

  const windows =
    windowsOverride ??
    getReservationWindows(schedule, scheduleMode, reservationWindowMode, customWindows);

  if (windows.length === 0) return [];

  if (mode === 'clock_aligned') {
    return generateTimeSlotsClockAligned(
      windows,
      intervalMinutes,
      reservationDurationMinutes,
      reservationEndPolicy
    );
  }

  return generateTimeSlotsLegacy(windows, reservationDurationMinutes, reservationEndPolicy);
}

function generateTimeSlotsForRestaurant(
  restaurant,
  schedule,
  partySize,
  durationRules,
  customWindows = []
) {
  const mode = resolveEffectiveSlotMode(restaurant);
  const reservationDuration = resolveDuration(restaurant, partySize, durationRules);
  const intervalMinutes =
    mode === 'clock_aligned'
      ? restaurant.slotIntervalMinutes ?? reservationDuration
      : reservationDuration;

  return generateTimeSlots({
    mode,
    schedule,
    scheduleMode: schedule.scheduleMode ?? restaurant.scheduleMode ?? 'continuous',
    intervalMinutes,
    reservationDurationMinutes: reservationDuration,
    reservationEndPolicy: restaurant.reservationEndPolicy ?? 'STRICT_END',
    reservationWindowMode: restaurant.reservationWindowMode ?? 'same_as_schedule',
    customWindows,
  });
}

function isSlotInSchedule(
  schedule,
  timeMin,
  reservationDurationMinutes,
  scheduleMode = 'continuous',
  reservationEndPolicy = 'STRICT_END',
  reservationWindowMode = 'same_as_schedule',
  customWindows = []
) {
  const windows = getReservationWindows(
    schedule,
    scheduleMode,
    reservationWindowMode,
    customWindows
  );
  return windows.some(([start, end]) => {
    if (timeMin < start) return false;
    return slotFitsWindow(timeMin, reservationDurationMinutes, end, reservationEndPolicy);
  });
}

function resolveDuration(restaurant, partySize, durationRules) {
  if (durationRules && durationRules.length > 0) {
    const sorted = [...durationRules].sort((a, b) => a.minPartySize - b.minPartySize);
    const rule = sorted.find(
      (r) => partySize >= r.minPartySize && partySize <= r.maxPartySize
    );
    if (rule) return rule.durationMinutes;
  }
  return restaurant?.defaultSlotDurationMinutes ?? 60;
}

function compareEngines(params) {
  const legacy = generateTimeSlots({ ...params, mode: 'legacy' });
  const clockAligned = generateTimeSlots({ ...params, mode: 'clock_aligned' });
  const legacyTimes = legacy.map((s) => s.time);
  const clockTimes = clockAligned.map((s) => s.time);
  const onlyLegacy = legacyTimes.filter((t) => !clockTimes.includes(t));
  const onlyClock = clockTimes.filter((t) => !legacyTimes.includes(t));
  return {
    legacyCount: legacy.length,
    clockAlignedCount: clockAligned.length,
    legacyFirst: legacyTimes[0] ?? null,
    legacyLast: legacyTimes[legacyTimes.length - 1] ?? null,
    clockFirst: clockTimes[0] ?? null,
    clockLast: clockTimes[clockTimes.length - 1] ?? null,
    onlyLegacy,
    onlyClock,
    hasDiff: onlyLegacy.length > 0 || onlyClock.length > 0,
  };
}

function maybeLogShadowCompare(context, compareResult) {
  if (!isShadowSlotEngineEnabled() || !compareResult.hasDiff) return;
  logger.info(
    {
      ...context,
      shadow: compareResult,
    },
    'slot engine shadow diff'
  );
}

/**
 * Validates that a reservation start time fits schedule / reservation windows.
 * @returns {{ valid: boolean, durationMinutes: number }}
 */
function validateSlotInSchedule(
  schedule,
  timeMin,
  restaurant,
  partySize,
  durationRules,
  customWindows = []
) {
  const durationMinutes = resolveDuration(restaurant, partySize, durationRules);
  const valid = isSlotInSchedule(
    schedule,
    timeMin,
    durationMinutes,
    restaurant.scheduleMode ?? 'continuous',
    restaurant.reservationEndPolicy ?? 'STRICT_END',
    restaurant.reservationWindowMode ?? 'same_as_schedule',
    customWindows
  );
  return { valid, durationMinutes };
}

module.exports = {
  AVAILABILITY_ENGINE_VERSION,
  resolveEffectiveSlotMode,
  getOperatingWindows,
  getReservationWindows,
  alignToGrid,
  generateTimeSlots,
  generateTimeSlotsLegacy,
  generateTimeSlotsClockAligned,
  generateTimeSlotsForRestaurant,
  isSlotInSchedule,
  validateSlotInSchedule,
  resolveDuration,
  compareEngines,
  maybeLogShadowCompare,
};
