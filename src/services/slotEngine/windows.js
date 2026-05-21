'use strict';

/**
 * slotEngine/windows.js
 *
 * Cálculo de ventanas donde se ofrecen cupos de reserva.
 *
 * Concepto clave: las ventanas de reserva son INDEPENDIENTES del horario de operación.
 * - Si reservationWindowMode = 'same_as_schedule' → las ventanas igualan al horario operativo.
 * - Si reservationWindowMode = 'custom' → se usan las ventanas definidas explícitamente,
 *   que DEBEN estar contenidas dentro del horario operativo (se valida al guardar, no aquí).
 *
 * Formato interno: [[startMin, endMin], ...] (minutos desde medianoche).
 */

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
 * Convierte minutos desde medianoche a "HH:mm".
 * @param {number} minutes
 * @returns {string}
 */
function minutesToTime(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Ventanas del horario de operación.
 * @param {{ scheduleMode?: string; openTime?: string; closeTime?: string;
 *            breakfastStartTime?: string; breakfastEndTime?: string;
 *            lunchStartTime?: string; lunchEndTime?: string;
 *            dinnerStartTime?: string; dinnerEndTime?: string; } | null} schedule
 * @param {string} scheduleMode - 'continuous' | 'service_periods'
 * @returns {Array<[number, number]>}
 */
function getOperatingWindows(schedule, scheduleMode = 'continuous') {
  if (!schedule) return [];

  if (scheduleMode === 'service_periods') {
    const periods = [
      [schedule.breakfastStartTime, schedule.breakfastEndTime],
      [schedule.lunchStartTime, schedule.lunchEndTime],
      [schedule.dinnerStartTime, schedule.dinnerEndTime],
    ];
    const windows = [];
    for (const [start, end] of periods) {
      if (start && end) {
        const s = timeToMinutes(start);
        const e = timeToMinutes(end);
        if (s < e) windows.push([s, e]);
      }
    }
    return windows;
  }

  const s = timeToMinutes(schedule.openTime ?? '00:00');
  const e = timeToMinutes(schedule.closeTime ?? '23:59');
  return s < e ? [[s, e]] : [];
}

/**
 * Ventanas donde se generan cupos reservables.
 * Si reservationWindowMode = 'custom' y hay ventanas definidas, las usa.
 * En caso contrario, usa el horario de operación.
 *
 * @param {{ openTime?: string; closeTime?: string; [key: string]: any } | null} schedule
 * @param {string} scheduleMode
 * @param {'same_as_schedule'|'custom'} reservationWindowMode
 * @param {Array<{ startTime: string; endTime: string }>} customWindows
 * @returns {Array<[number, number]>}
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
        const s = timeToMinutes(w.startTime);
        const e = timeToMinutes(w.endTime);
        if (s < e) windows.push([s, e]);
      }
      if (windows.length > 0) return windows;
    }
  }
  return getOperatingWindows(schedule, scheduleMode);
}

/**
 * Valida que las ventanas custom estén contenidas dentro del horario operativo del día.
 * Retorna lista de ventanas inválidas (vacío = todas ok).
 *
 * @param {Array<[number, number]>} operatingWindows
 * @param {Array<[number, number]>} customWindows
 * @returns {Array<[number, number]>} ventanas fuera del horario
 */
function findWindowsOutsideOperating(operatingWindows, customWindows) {
  return customWindows.filter(([cs, ce]) => {
    return !operatingWindows.some(([os, oe]) => cs >= os && ce <= oe);
  });
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  getOperatingWindows,
  getReservationWindows,
  findWindowsOutsideOperating,
};
