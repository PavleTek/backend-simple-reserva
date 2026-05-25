'use strict';

/**
 * slotEngine/windows.js
 *
 * Cálculo de ventanas donde se ofrecen cupos de reserva.
 *
 * Formato interno: [[startMin, endMin], ...] (minutos desde medianoche del día de apertura;
 * endMin puede superar 1440 cuando endsNextDay / closesNextDay).
 */

const { isCrossMidnightEnabled } = require('../../lib/featureFlags');

/**
 * Convierte una cadena "HH:mm" a minutos desde medianoche.
 * @param {string} timeStr
 * @returns {number}
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Convierte minutos desde medianoche a "HH:mm" (wraps at 24h for display).
 * @param {number} minutes
 * @returns {string}
 */
function minutesToTime(minutes) {
  const local = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(local / 60)).padStart(2, '0');
  const mm = String(local % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Wraps [start, end] when period ends next calendar day.
 * @param {number} start
 * @param {number} end
 * @param {boolean} endsNextDay
 * @returns {[number, number]|null}
 */
function wrapWindow(start, end, endsNextDay) {
  const s = start;
  let e = end;
  if (endsNextDay && isCrossMidnightEnabled()) {
    e = end + 1440;
  }
  if (s >= e) return null;
  if (e - s > 1440) return null;
  return [s, e];
}

/**
 * Ventanas del horario de operación.
 */
function getOperatingWindows(schedule, scheduleMode = 'continuous') {
  if (!schedule) return [];

  if (scheduleMode === 'service_periods') {
    const periods = [
      [schedule.breakfastStartTime, schedule.breakfastEndTime, false],
      [schedule.lunchStartTime, schedule.lunchEndTime, false],
      [schedule.dinnerStartTime, schedule.dinnerEndTime, !!schedule.dinnerEndsNextDay],
    ];
    const windows = [];
    for (const [start, end, endsNextDay] of periods) {
      if (start && end) {
        const w = wrapWindow(timeToMinutes(start), timeToMinutes(end), endsNextDay);
        if (w) windows.push(w);
      }
    }
    return windows;
  }

  const s = timeToMinutes(schedule.openTime ?? '00:00');
  const e = timeToMinutes(schedule.closeTime ?? '23:59');
  const closesNextDay = !!schedule.closesNextDay && isCrossMidnightEnabled();

  if (!closesNextDay) {
    return s < e ? [[s, e]] : [];
  }

  const w = wrapWindow(s, e, true);
  return w ? [w] : [];
}

/**
 * Ventanas donde se generan cupos reservables.
 */
function getReservationWindows(
  schedule,
  scheduleMode,
  reservationWindowMode = 'same_as_schedule',
  customWindows = []
) {
  if (reservationWindowMode === 'custom' && Array.isArray(customWindows)) {
    const scheduleDow = schedule?.dayOfWeek;
    const forDay =
      scheduleDow != null
        ? customWindows.filter(
            (w) => w.dayOfWeek === scheduleDow || w.dayOfWeek === undefined || w.dayOfWeek === null,
          )
        : customWindows;

    if (forDay.length > 0) {
      const windows = [];
      for (const w of forDay) {
        if (!w.startTime || !w.endTime) continue;
        const wrapped = wrapWindow(
          timeToMinutes(w.startTime),
          timeToMinutes(w.endTime),
          !!w.endsNextDay,
        );
        if (wrapped) windows.push(wrapped);
      }
      if (windows.length > 0) return windows;
    }
  }
  return getOperatingWindows(schedule, scheduleMode);
}

/**
 * Valida que las ventanas custom estén contenidas dentro del horario operativo del día.
 * Soporta ventanas operativas cross-midnight (endMin > 1440).
 */
function findWindowsOutsideOperating(operatingWindows, customWindows) {
  return customWindows.filter(([cs, ce]) => {
    return !operatingWindows.some(([os, oe]) => cs >= os && ce <= oe);
  });
}

/**
 * Slot display time and calendar offset from grid minutes.
 */
function slotFromGridMinutes(m) {
  const dayOffset = Math.floor(m / 1440);
  const localMin = m % 1440;
  return {
    time: minutesToTime(localMin),
    startMin: m,
    endMin: m,
    dayOffset,
    nextDay: dayOffset > 0,
  };
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  wrapWindow,
  getOperatingWindows,
  getReservationWindows,
  findWindowsOutsideOperating,
  slotFromGridMinutes,
};
