'use strict';

/**
 * slotEngine/blockRules.js
 *
 * Bloqueo derivado de mesas vinculadas (TableBlockRule).
 *
 * Una regla declara: cuando `triggerTableId` tiene una reserva o hold activo con
 * partySize >= minPartySize (o cualquier tamaño si minPartySize es null),
 * `blockedTableId` queda bloqueada durante ese mismo intervalo — no aparece
 * disponible y no puede recibir una nueva reserva.
 *
 * Reglas directas únicamente: no se cascadea (si A bloquea B y B bloquea C,
 * una reserva en A NO bloquea C).
 *
 * Sustituciones puntuales (ReservationTableSwap, opcional):
 * - Una reserva concreta puede reemplazar una de sus mesas vinculadas por defecto
 *   (p. ej. A1, porque ya tenía una reserva propia que no se pudo mover) por otra
 *   mesa libre (p. ej. A6), solo para esa reserva. Ver `applySwaps`.
 */

function overlapsRange(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

function ruleApplies(rule, partySize) {
  return rule.minPartySize == null || partySize == null || partySize >= rule.minPartySize;
}

/**
 * Reemplaza, dentro de una lista de IDs de mesa, cada mesa original por su sustituta
 * según una lista de swaps puntuales. Mesas sin swap quedan igual.
 *
 * @param {string[]} tableIds
 * @param {Array<{originalTableId: string, substituteTableId: string}>} swaps
 * @returns {string[]}
 */
function applySwaps(tableIds, swaps) {
  if (!swaps?.length) return tableIds;
  const substituteByOriginal = new Map(swaps.map((s) => [s.originalTableId, s.substituteTableId]));
  return tableIds.map((id) => substituteByOriginal.get(id) ?? id);
}

/**
 * IDs de mesas bloqueadas en [slotStart, slotEnd) por reservas/holds activos en sus mesas gatillo.
 *
 * @param {Array<{id?: string, tableId: string|null, start: Date, end: Date, partySize?: number|null}>} parsedReservations
 * @param {Array<{tableId: string, start: Date, end: Date, partySize?: number|null, holdToken: string}>} parsedHolds
 * @param {Array<{triggerTableId: string, blockedTableId: string, minPartySize: number|null}>} blockRules
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {string|null} [excludeHoldToken] - hold propio del usuario (se excluye, igual que en capacity.js)
 * @param {Map<string, Array<{originalTableId: string, substituteTableId: string}>>} [swapsByReservationId] -
 *   swaps persistidos (ReservationTableSwap) de las reservas gatillo, indexados por reservation.id.
 * @returns {Set<string>}
 */
function getDerivedBlockedTableIds(
  parsedReservations,
  parsedHolds,
  blockRules,
  slotStart,
  slotEnd,
  excludeHoldToken = null,
  swapsByReservationId = null
) {
  const blocked = new Set();
  if (!blockRules?.length) return blocked;

  const rulesByTrigger = new Map();
  for (const rule of blockRules) {
    const list = rulesByTrigger.get(rule.triggerTableId) || [];
    list.push(rule);
    rulesByTrigger.set(rule.triggerTableId, list);
  }

  const applyFrom = (triggerTableId, start, end, partySize, reservationId) => {
    if (!triggerTableId) return;
    const rules = rulesByTrigger.get(triggerTableId);
    if (!rules) return;
    if (!overlapsRange(slotStart, slotEnd, start, end)) return;
    const swaps = reservationId ? swapsByReservationId?.get(reservationId) : null;
    for (const rule of rules) {
      if (!ruleApplies(rule, partySize)) continue;
      const [resolvedId] = swaps ? applySwaps([rule.blockedTableId], swaps) : [rule.blockedTableId];
      blocked.add(resolvedId);
    }
  };

  for (const r of parsedReservations) {
    applyFrom(r.tableId, r.start, r.end, r.partySize, r.id);
  }
  for (const h of parsedHolds) {
    if (excludeHoldToken && h.holdToken === excludeHoldToken) continue;
    applyFrom(h.tableId, h.start, h.end, h.partySize, null);
  }

  return blocked;
}

/**
 * IDs de mesas que deben estar libres para que `tableId` acepte una reserva de
 * `partySize`, según sus reglas directas como mesa gatillo.
 *
 * @param {string} tableId
 * @param {number} partySize
 * @param {Array<{triggerTableId: string, blockedTableId: string, minPartySize: number|null}>} blockRules
 * @param {Array<{originalTableId: string, substituteTableId: string}>} [swaps] - sustituciones
 *   propuestas/persistidas para ESTA reserva (no las de otras reservas gatillo).
 * @returns {string[]}
 */
function getRequiredLinkedTableIds(tableId, partySize, blockRules, swaps = []) {
  if (!blockRules?.length) return [];
  const defaultIds = blockRules
    .filter((rule) => rule.triggerTableId === tableId && ruleApplies(rule, partySize))
    .map((rule) => rule.blockedTableId);
  return applySwaps(defaultIds, swaps);
}

module.exports = {
  getDerivedBlockedTableIds,
  getRequiredLinkedTableIds,
  applySwaps,
  ruleApplies,
};
