'use strict';

/**
 * slotEngine/duration.js
 *
 * Resolución de duración de reserva por tamaño de grupo (party size).
 * Las DurationRules son INDEPENDIENTES del intervalo de cupos.
 *
 * Contrato:
 * - Se busca la primera regla donde minPartySize <= partySize <= maxPartySize.
 * - Si ninguna regla coincide, se usa defaultSlotDurationMinutes del restaurante.
 * - Una reserva de X personas bloquea su mesa por `durationMinutes` minutos,
 *   independientemente de cada cuánto aparecen los cupos.
 */

/**
 * Resuelve la duración de reserva para un grupo de personas.
 *
 * @param {{ defaultSlotDurationMinutes?: number }} restaurant
 * @param {number} partySize
 * @param {Array<{ minPartySize: number; maxPartySize: number; durationMinutes: number }>} durationRules
 * @returns {number} - duración en minutos
 */
function resolveDuration(restaurant, partySize, durationRules) {
  if (Array.isArray(durationRules) && durationRules.length > 0) {
    const sorted = [...durationRules].sort((a, b) => a.minPartySize - b.minPartySize);
    const rule = sorted.find(
      (r) => partySize >= r.minPartySize && partySize <= r.maxPartySize
    );
    if (rule) return rule.durationMinutes;
  }
  return restaurant?.defaultSlotDurationMinutes ?? 60;
}

module.exports = { resolveDuration };
