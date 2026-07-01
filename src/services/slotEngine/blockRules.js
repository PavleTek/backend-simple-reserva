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
 */

function overlapsRange(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

function ruleApplies(rule, partySize) {
  return rule.minPartySize == null || partySize == null || partySize >= rule.minPartySize;
}

/**
 * IDs de mesas bloqueadas en [slotStart, slotEnd) por reservas/holds activos en sus mesas gatillo.
 *
 * @param {Array<{tableId: string|null, start: Date, end: Date, partySize?: number|null}>} parsedReservations
 * @param {Array<{tableId: string, start: Date, end: Date, partySize?: number|null, holdToken: string}>} parsedHolds
 * @param {Array<{triggerTableId: string, blockedTableId: string, minPartySize: number|null}>} blockRules
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {string|null} [excludeHoldToken] - hold propio del usuario (se excluye, igual que en capacity.js)
 * @returns {Set<string>}
 */
function getDerivedBlockedTableIds(parsedReservations, parsedHolds, blockRules, slotStart, slotEnd, excludeHoldToken = null) {
  const blocked = new Set();
  if (!blockRules?.length) return blocked;

  const rulesByTrigger = new Map();
  for (const rule of blockRules) {
    const list = rulesByTrigger.get(rule.triggerTableId) || [];
    list.push(rule);
    rulesByTrigger.set(rule.triggerTableId, list);
  }

  const applyFrom = (triggerTableId, start, end, partySize) => {
    if (!triggerTableId) return;
    const rules = rulesByTrigger.get(triggerTableId);
    if (!rules) return;
    if (!overlapsRange(slotStart, slotEnd, start, end)) return;
    for (const rule of rules) {
      if (ruleApplies(rule, partySize)) blocked.add(rule.blockedTableId);
    }
  };

  for (const r of parsedReservations) {
    applyFrom(r.tableId, r.start, r.end, r.partySize);
  }
  for (const h of parsedHolds) {
    if (excludeHoldToken && h.holdToken === excludeHoldToken) continue;
    applyFrom(h.tableId, h.start, h.end, h.partySize);
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
 * @returns {string[]}
 */
function getRequiredLinkedTableIds(tableId, partySize, blockRules) {
  if (!blockRules?.length) return [];
  return blockRules
    .filter((rule) => rule.triggerTableId === tableId && ruleApplies(rule, partySize))
    .map((rule) => rule.blockedTableId);
}

module.exports = {
  getDerivedBlockedTableIds,
  getRequiredLinkedTableIds,
  ruleApplies,
};
