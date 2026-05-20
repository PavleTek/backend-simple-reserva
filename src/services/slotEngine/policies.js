'use strict';

/**
 * slotEngine/policies.js
 *
 * Políticas de booking que filtran cupos ya generados por la grilla.
 *
 * - minimumNoticeMinutes: aviso mínimo desde "ahora" para reservas del día actual.
 * - advanceBookingLimitDays: límite de días hacia adelante (validado también al crear reserva).
 * - blockedSlots: cupos que intersectan un bloqueo manual se eliminan.
 * - walkIn: si true, se ignora minimumNoticeMinutes (reserva en el acto desde el panel).
 */

/**
 * @param {Array<{ startUtc: string; endUtc: string }>} blockedSlots
 * @returns {Array<{ start: Date; end: Date }>}
 */
function parseBlockedSlots(blockedSlots) {
  return (blockedSlots || []).map((bs) => ({
    start: new Date(bs.startUtc),
    end: new Date(bs.endUtc),
  }));
}

/**
 * Filtra cupos según políticas aplicables al día.
 *
 * @param {Array<{ time: string; start: Date; end: Date }>} timeSlots
 * @param {object} params
 * @param {boolean} params.isToday
 * @param {boolean} [params.walkIn]
 * @param {Date} params.nowDate
 * @param {number} params.minimumNoticeMinutes
 * @param {Array<{ start: Date; end: Date }>} params.parsedBlockedSlots
 * @returns {Array<{ time: string; start: Date; end: Date }>}
 */
function applyPolicies(timeSlots, { isToday, walkIn, nowDate, minimumNoticeMinutes, parsedBlockedSlots }) {
  let slots = timeSlots;

  // Filtro de aviso mínimo (solo para hoy, ignorado en walk-in)
  if (isToday) {
    const minSlotTime = walkIn
      ? nowDate
      : new Date(nowDate.getTime() + minimumNoticeMinutes * 60000);
    slots = slots.filter((slot) => slot.start >= minSlotTime);
  }

  // Filtro de bloqueos
  if (parsedBlockedSlots.length > 0) {
    slots = slots.filter(
      (slot) => !parsedBlockedSlots.some((bs) => slot.start < bs.end && slot.end > bs.start)
    );
  }

  return slots;
}

/**
 * Valida que una fecha de reserva cumpla las políticas avance/aviso.
 * @param {Date} dateTime - inicio del slot en UTC
 * @param {Date} now
 * @param {number} minimumNoticeMinutes
 * @param {number} advanceBookingLimitDays
 * @param {boolean} [walkIn]
 * @returns {{ valid: boolean; reason?: string }}
 */
function validateBookingPolicies(dateTime, now, minimumNoticeMinutes, advanceBookingLimitDays, walkIn = false) {
  if (!walkIn) {
    const minTime = new Date(now.getTime() + minimumNoticeMinutes * 60000);
    if (dateTime < minTime) {
      const hours = Math.floor(minimumNoticeMinutes / 60);
      const mins = minimumNoticeMinutes % 60;
      const label = hours > 0
        ? `${hours} hora${hours > 1 ? 's' : ''}${mins > 0 ? ` y ${mins} min` : ''}`
        : `${mins} minutos`;
      return { valid: false, reason: `Debes reservar con al menos ${label} de anticipación` };
    }
  }

  const limitMs = now.getTime() + advanceBookingLimitDays * 24 * 60 * 60 * 1000;
  const limitDate = new Date(limitMs);
  // Darle hasta el final del día límite
  limitDate.setHours(23, 59, 59, 999);
  if (dateTime > limitDate) {
    return { valid: false, reason: `Solo se puede reservar hasta ${advanceBookingLimitDays} días por adelantado` };
  }

  return { valid: true };
}

module.exports = {
  parseBlockedSlots,
  applyPolicies,
  validateBookingPolicies,
};
