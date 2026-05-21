'use strict';

/**
 * slotEngine/grid.js
 *
 * Generación de la grilla de cupos — siempre alineada al reloj.
 *
 * Motor único v3: NO existe modo "legacy". El intervalo se configura
 * explícitamente con slotIntervalMinutes (mín. 5 min).
 * El primer cupo del día es el primer múltiplo del intervalo >= apertura de la ventana.
 *
 * Política de fin (reservationEndPolicy):
 * - STRICT_END: la reserva completa debe terminar dentro de la ventana.
 * - ALLOW_OVERFLOW: el cupo comienza dentro de la ventana aunque la reserva supere el cierre.
 */

const { minutesToTime } = require('./windows');

/**
 * Alinea `minute` al siguiente múltiplo de `intervalMinutes` >= minute.
 * @param {number} minute
 * @param {number} intervalMinutes
 * @returns {number}
 */
function alignToGrid(minute, intervalMinutes) {
  if (intervalMinutes <= 0) return minute;
  const remainder = minute % intervalMinutes;
  return remainder === 0 ? minute : minute + (intervalMinutes - remainder);
}

/**
 * Determina si un cupo cabe dentro de la ventana.
 * @param {number} startMin - inicio del cupo (minutos desde medianoche)
 * @param {number} durationMinutes - duración de la reserva
 * @param {number} windowEnd - fin de la ventana (minutos)
 * @param {'STRICT_END'|'ALLOW_OVERFLOW'} policy
 * @returns {boolean}
 */
function slotFitsWindow(startMin, durationMinutes, windowEnd, policy) {
  if (policy === 'ALLOW_OVERFLOW') {
    return startMin < windowEnd;
  }
  return startMin + durationMinutes <= windowEnd;
}

/**
 * Genera la grilla de cupos para un conjunto de ventanas.
 *
 * @param {Array<[number, number]>} windows - [[startMin, endMin], ...]
 * @param {number} intervalMinutes - paso entre cupos (mín. 5 min)
 * @param {number} durationMinutes - duración de la reserva para la política de fin
 * @param {'STRICT_END'|'ALLOW_OVERFLOW'} [reservationEndPolicy]
 * @returns {Array<{ time: string; startMin: number; endMin: number }>}
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
      slots.push({ time: minutesToTime(m), startMin: m, endMin: m + durationMinutes });
      m += interval;
    }
  }

  return slots;
}

/**
 * Verifica que un tiempo exacto (en minutos) sea un cupo válido de la grilla.
 * Usado en validateSlotForBooking para rechazar horarios fuera de la grilla.
 *
 * @param {number} timeMin - tiempo a verificar (minutos desde medianoche)
 * @param {Array<[number, number]>} windows
 * @param {number} intervalMinutes
 * @param {number} durationMinutes
 * @param {'STRICT_END'|'ALLOW_OVERFLOW'} [reservationEndPolicy]
 * @returns {boolean}
 */
function isOnGrid(timeMin, windows, intervalMinutes, durationMinutes, reservationEndPolicy = 'STRICT_END') {
  const interval = Math.max(5, intervalMinutes);
  for (const [startMin, endMin] of windows) {
    const gridStart = alignToGrid(startMin, interval);
    if (timeMin < gridStart) continue;
    if (!slotFitsWindow(timeMin, durationMinutes, endMin, reservationEndPolicy)) continue;
    // El cupo debe ser un múltiplo del intervalo (desde gridStart)
    if ((timeMin - gridStart) % interval === 0) return true;
  }
  return false;
}

module.exports = {
  alignToGrid,
  slotFitsWindow,
  generateGrid,
  isOnGrid,
};
