'use strict';

/**
 * slotEngine/grid.js — Generación de la grilla de cupos (cross-midnight aware).
 */

const { minutesToTime, slotFromGridMinutes } = require('./windows');

function alignToGrid(minute, intervalMinutes) {
  if (intervalMinutes <= 0) return minute;
  const remainder = minute % intervalMinutes;
  return remainder === 0 ? minute : minute + (intervalMinutes - remainder);
}

function slotFitsWindow(startMin, durationMinutes, windowEnd, policy) {
  if (policy === 'ALLOW_OVERFLOW') {
    return startMin < windowEnd;
  }
  return startMin + durationMinutes <= windowEnd;
}

/**
 * @returns {Array<{ time: string; startMin: number; endMin: number; dayOffset: number; nextDay: boolean }>}
 */
function generateGrid(
  windows,
  intervalMinutes,
  durationMinutes,
  reservationEndPolicy = 'STRICT_END'
) {
  const interval = Math.max(5, intervalMinutes);
  const slots = [];

  for (const [startMin, endMin] of windows) {
    let m = alignToGrid(startMin, interval);
    while (slotFitsWindow(m, durationMinutes, endMin, reservationEndPolicy)) {
      const base = slotFromGridMinutes(m);
      slots.push({
        ...base,
        endMin: m + durationMinutes,
      });
      m += interval;
    }
  }

  return slots;
}

function isOnGrid(timeMin, windows, intervalMinutes, durationMinutes, reservationEndPolicy = 'STRICT_END') {
  const interval = Math.max(5, intervalMinutes);
  for (const [startMin, endMin] of windows) {
    const gridStart = alignToGrid(startMin, interval);
    if (timeMin < gridStart) continue;
    if (!slotFitsWindow(timeMin, durationMinutes, endMin, reservationEndPolicy)) continue;
    if ((timeMin - gridStart) % interval === 0) return true;
  }
  return false;
}

/**
 * Maps wall-clock HH:mm + optional nextDay to grid minutes for validation.
 */
function timeToGridMinutes(timeStr, nextDay = false) {
  const { timeToMinutes } = require('./windows');
  return timeToMinutes(timeStr) + (nextDay ? 1440 : 0);
}

module.exports = {
  alignToGrid,
  slotFitsWindow,
  generateGrid,
  isOnGrid,
  timeToGridMinutes,
};
