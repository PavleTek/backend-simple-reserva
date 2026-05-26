'use strict';

/**
 * slotEngine/capacity.js
 *
 * Verificación de capacidad para un cupo: mesas libres, buffer, holds activos y pacing.
 *
 * RESTRICCIÓN FUNDAMENTAL (v3):
 * Una reserva ocupa UNA Y SOLO UNA mesa física. No hay combinación automática de mesas
 * ni "table joins". Si ninguna mesa individual tiene minCapacity ≤ partySize ≤ maxCapacity,
 * el cupo no está disponible (reason: 'party_size_exceeds_largest_table').
 *
 * Un cupo está BLOQUEADO por:
 * 1. Una Reservation confirmada o en sala (confirmed/arrived) que solapa el intervalo (más buffer).
 * 2. Un ReservationHold con status='active' y expiresAt > now() que solapa el intervalo.
 *    Excepción: holds con holdToken === excludeHoldToken se ignoran (el propio hold del usuario).
 *
 * Pacing:
 * - Se aplica además del chequeo de mesas.
 * - maxCoversPerSlot: max personas totales reservadas (confirmed + holds activos) en el cupo.
 * - maxReservationsPerSlot: max reservas totales en el cupo.
 * - Si no hay PacingRule, solo se chequea disponibilidad de mesas.
 */

/**
 * Determina si dos intervalos [s1,e1) y [s2,e2) se solapan.
 * @param {Date} s1 @param {Date} e1 @param {Date} s2 @param {Date} e2
 * @returns {boolean}
 */
function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

/**
 * Candidatos válidos para un partySize (sin filtro de zona si zoneId es null/undefined).
 *
 * @param {Array<{ id: string; zoneId: string; minCapacity: number; maxCapacity: number }>} tables
 * @param {number} partySize
 * @param {string|null|undefined} zoneId
 * @returns {Array<typeof tables[0]>}
 */
function getCandidateTables(tables, partySize, zoneId) {
  return tables.filter(
    (t) =>
      t.minCapacity <= partySize &&
      t.maxCapacity >= partySize &&
      (!zoneId || t.zoneId === zoneId)
  );
}

/**
 * Cuántas mesas candidatas están libres para un slot dado.
 * Considera reservas confirmadas, holds activos (no expirados) y buffer.
 *
 * @param {Array<{ id: string }>} candidateTables
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {number} bufferMs
 * @param {Array<{ tableId: string|null; start: Date; end: Date }>} parsedReservations
 * @param {Array<{ tableId: string; start: Date; end: Date; holdToken: string }>} parsedHolds
 * @param {string|null} [excludeHoldToken] - hold propio del usuario (se excluye)
 * @returns {number} - cantidad de mesas libres
 */
function countFreeTables(
  candidateTables,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken = null
) {
  let free = 0;
  for (const table of candidateTables) {
    const reservationConflict = parsedReservations.some((r) => {
      if (r.tableId !== table.id) return false;
      const rEnd = new Date(r.end.getTime() + bufferMs);
      return overlaps(slotStart, slotEnd, r.start, rEnd);
    });
    if (reservationConflict) continue;

    const holdConflict = parsedHolds.some((h) => {
      if (h.tableId !== table.id) return false;
      if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
      return overlaps(slotStart, slotEnd, h.start, h.end);
    });
    if (holdConflict) continue;

    free++;
  }
  return free;
}

/**
 * Selecciona la mejor mesa libre para una reserva (menor slack primero, luego sortOrder).
 * Una reserva = UNA mesa. Devuelve null si no hay mesa disponible.
 *
 * @param {Array<{ id: string; zoneId: string; maxCapacity: number; sortOrder?: number; zone?: { id: string; sortOrder?: number } }>} tables
 * @param {number} partySize
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {number} bufferMs
 * @param {Array<{ tableId: string|null; start: Date; end: Date }>} parsedReservations
 * @param {Array<{ tableId: string; start: Date; end: Date; holdToken: string }>} parsedHolds
 * @param {string|null} preferredZoneId
 * @param {string|null} [excludeHoldToken]
 * @returns {typeof tables[0] | null}
 */
function pickTable(
  tables,
  partySize,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  preferredZoneId,
  excludeHoldToken = null
) {
  const candidates = getCandidateTables(tables, partySize, null);
  const free = candidates.filter((t) => {
    const reservationConflict = parsedReservations.some((r) => {
      if (r.tableId !== t.id) return false;
      const rEnd = new Date(r.end.getTime() + bufferMs);
      return overlaps(slotStart, slotEnd, r.start, rEnd);
    });
    if (reservationConflict) return false;

    const holdConflict = parsedHolds.some((h) => {
      if (h.tableId !== t.id) return false;
      if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
      return overlaps(slotStart, slotEnd, h.start, h.end);
    });
    return !holdConflict;
  });

  if (free.length === 0) return null;

  free.sort((a, b) => {
    // Preferred zone first
    if (preferredZoneId) {
      const pa = a.zoneId === preferredZoneId ? 0 : 1;
      const pb = b.zoneId === preferredZoneId ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    // Least waste (smallest maxCapacity - partySize)
    const slackA = a.maxCapacity - partySize;
    const slackB = b.maxCapacity - partySize;
    if (slackA !== slackB) return slackA - slackB;
    // Zone sort order
    const za = (a.zone?.sortOrder ?? 0);
    const zb = (b.zone?.sortOrder ?? 0);
    if (za !== zb) return za - zb;
    // Table sort order
    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id));
  });

  return free[0];
}

/**
 * Aplica las reglas de pacing para un slot.
 * Retorna { ok: boolean, coversRemaining?: number, reservationsRemaining?: number }.
 *
 * @param {Array<{ dayOfWeek?: number|null; maxCoversPerSlot?: number|null; maxReservationsPerSlot?: number|null }>} pacingRules
 * @param {number} dayOfWeek - 0=domingo … 6=sábado
 * @param {number} confirmedCovers - personas ya reservadas en este slot (reservas + holds)
 * @param {number} confirmedReservations - reservas + holds en este slot
 * @param {number} requestedPartySize
 */
function checkPacing(pacingRules, dayOfWeek, confirmedCovers, confirmedReservations, requestedPartySize) {
  const rules = (pacingRules || []).filter(
    (r) => r.dayOfWeek == null || r.dayOfWeek === dayOfWeek
  );
  for (const rule of rules) {
    if (rule.maxCoversPerSlot != null) {
      if (confirmedCovers + requestedPartySize > rule.maxCoversPerSlot) {
        return {
          ok: false,
          reason: 'pacing_covers_exceeded',
          coversRemaining: Math.max(0, rule.maxCoversPerSlot - confirmedCovers),
        };
      }
    }
    if (rule.maxReservationsPerSlot != null) {
      if (confirmedReservations + 1 > rule.maxReservationsPerSlot) {
        return {
          ok: false,
          reason: 'pacing_reservations_exceeded',
          reservationsRemaining: Math.max(0, rule.maxReservationsPerSlot - confirmedReservations),
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Convierte array de reservas raw a formato normalizado.
 * @param {Array<{ tableId: string|null; startUtc: string; durationMinutes: number }>} reservations
 * @param {number} bufferMs - se usa en la comparación, no en el mapeo
 * @returns {Array<{ tableId: string|null; start: Date; end: Date }>}
 */
function parseReservations(reservations) {
  return reservations.map((r) => ({
    tableId: r.tableId,
    start: new Date(r.startUtc),
    end: new Date(new Date(r.startUtc).getTime() + r.durationMinutes * 60000),
  }));
}

/**
 * Convierte array de holds raw a formato normalizado.
 * @param {Array<{ tableId: string; startUtc: string; durationMinutes: number; holdToken: string }>} holds
 * @returns {Array<{ tableId: string; start: Date; end: Date; holdToken: string }>}
 */
function parseHolds(holds) {
  return holds.map((h) => ({
    tableId: h.tableId,
    start: new Date(h.startUtc),
    end: new Date(new Date(h.startUtc).getTime() + h.durationMinutes * 60000),
    holdToken: h.holdToken,
  }));
}

module.exports = {
  overlaps,
  getCandidateTables,
  countFreeTables,
  pickTable,
  checkPacing,
  parseReservations,
  parseHolds,
};
