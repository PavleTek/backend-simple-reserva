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
 *
 * Mesas vinculadas (TableBlockRule, opcional):
 * - Si `blockRules` se provee, una mesa gatillo con reserva/hold activo bloquea sus
 *   mesas vinculadas para ese intervalo (ver blockRules.js). Es recíproco: la mesa
 *   gatillo tampoco está disponible si alguna de sus mesas vinculadas requeridas
 *   está ocupada. Comportamiento 100% opt-in — sin blockRules, no hay cambios.
 */

const { getDerivedBlockedTableIds, getRequiredLinkedTableIds } = require('./blockRules');

/**
 * Determina si dos intervalos [s1,e1) y [s2,e2) se solapan.
 * @param {Date} s1 @param {Date} e1 @param {Date} s2 @param {Date} e2
 * @returns {boolean}
 */
function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

const EMPTY_LIST = [];

/**
 * Índice `tableId -> items` de una lista de reservas/holds parseados, memoizado
 * por identidad del array (WeakMap): dentro de un mismo cómputo de disponibilidad,
 * `computeAvailability` reutiliza la MISMA referencia de `parsedRes`/`parsedHoldsArr`
 * en cada slot, así que el índice se construye una sola vez por cómputo aunque
 * `isDirectlyFree` se llame S×T veces. Sin cambios de firma pública: quien llama
 * sigue pasando el array plano de siempre.
 */
const tableIndexCache = new WeakMap();

function getByTable(list, tableId) {
  if (!list.length) return EMPTY_LIST;
  let index = tableIndexCache.get(list);
  if (!index) {
    index = new Map();
    for (const item of list) {
      if (!item.tableId) continue;
      let bucket = index.get(item.tableId);
      if (!bucket) {
        bucket = [];
        index.set(item.tableId, bucket);
      }
      bucket.push(item);
    }
    tableIndexCache.set(list, index);
  }
  return index.get(tableId) ?? EMPTY_LIST;
}

function isTableBlockedBySessions(table, slotStart, slotEnd, blockingSessions) {
  if (!blockingSessions?.length) return false;
  for (const bs of blockingSessions) {
    const bsStart = bs.startAt instanceof Date ? bs.startAt : new Date(bs.startAt);
    const bsEnd = bs.endAt instanceof Date ? bs.endAt : new Date(bs.endAt);
    if (!overlaps(slotStart, slotEnd, bsStart, bsEnd)) continue;
    if (bs.blockScope === 'VENUE' || !bs.blockScope) return true;
    if (bs.blockScope === 'ZONES' && Array.isArray(bs.zoneIds) && bs.zoneIds.includes(table.zoneId)) {
      return true;
    }
  }
  return false;
}

/**
 * Tiempo (en ms) hasta la próxima reserva en una mesa, a partir de afterTime.
 * Retorna Infinity si no hay reservas futuras en esa mesa.
 *
 * @param {string} tableId
 * @param {Date} afterTime
 * @param {Array<{ tableId: string|null; start: Date; end: Date }>} parsedReservations
 * @returns {number}
 */
function msUntilNextReservation(tableId, afterTime, parsedReservations) {
  let nearest = Infinity;
  for (const r of getByTable(parsedReservations, tableId)) {
    if (r.start < afterTime) continue;
    const gap = r.start.getTime() - afterTime.getTime();
    if (gap < nearest) nearest = gap;
  }
  return nearest;
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
 * Verifica si una mesa está libre de reservas/holds directos (sin considerar
 * sesiones de actividad ni mesas vinculadas — esos se chequean por separado).
 *
 * @param {string} tableId
 * @param {Date} slotStart @param {Date} slotEnd @param {number} bufferMs
 * @param {Array<{ tableId: string|null; start: Date; end: Date }>} parsedReservations
 * @param {Array<{ tableId: string; start: Date; end: Date; holdToken: string }>} parsedHolds
 * @param {string|null} excludeHoldToken
 * @returns {boolean}
 */
function isDirectlyFree(tableId, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, excludeHoldToken) {
  const reservationConflict = getByTable(parsedReservations, tableId).some((r) => {
    const rEnd = new Date(r.end.getTime() + bufferMs);
    return overlaps(slotStart, slotEnd, r.start, rEnd);
  });
  if (reservationConflict) return false;

  const holdConflict = getByTable(parsedHolds, tableId).some((h) => {
    if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
    return overlaps(slotStart, slotEnd, h.start, h.end);
  });
  return !holdConflict;
}

/**
 * Determina si alguna de las mesas vinculadas requeridas por `tableId` (para aceptar
 * `partySize`) está ocupada — ya sea por reserva/hold directo, sesión bloqueante o
 * bloqueo derivado de otra mesa gatillo. Sin blockRules, siempre retorna false.
 *
 * @param {Array<{originalTableId: string, substituteTableId: string}>} [proposedSwaps] -
 *   sustituciones propuestas/persistidas para la reserva de `tableId` (no de otras mesas gatillo).
 */
function hasLinkedTableConflict(
  tableId,
  partySize,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken,
  blockingSessions,
  blockRules,
  derivedBlockedIds,
  tableById,
  proposedSwaps = []
) {
  if (!blockRules?.length) return false;
  const requiredLinked = getRequiredLinkedTableIds(tableId, partySize, blockRules, proposedSwaps);
  return requiredLinked.some((linkedId) => {
    const linkedTable = tableById.get(linkedId);
    if (linkedTable && isTableBlockedBySessions(linkedTable, slotStart, slotEnd, blockingSessions)) return true;
    if (derivedBlockedIds.has(linkedId)) return true;
    return !isDirectlyFree(linkedId, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, excludeHoldToken);
  });
}

/**
 * Lista las mesas candidatas libres para un slot dado. Considera reservas
 * confirmadas, holds activos (no expirados), buffer, sesiones bloqueantes y —
 * si se provee `opts.blockRules` — mesas vinculadas (bidireccional).
 *
 * Factorizada para que countFreeTables y pickTable (y cualquier otro caller
 * que necesite el detalle, no solo el total) compartan una sola pasada:
 * derivedBlockedIds y tableById se calculan una vez por llamada, no una vez
 * por mesa candidata.
 *
 * @param {Array<{ id: string }>} candidateTables
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {number} bufferMs
 * @param {Array<{ tableId: string|null; start: Date; end: Date; partySize?: number|null }>} parsedReservations
 * @param {Array<{ tableId: string; start: Date; end: Date; holdToken: string; partySize?: number|null }>} parsedHolds
 * @param {string|null} [excludeHoldToken] - hold propio del usuario (se excluye)
 * @param {Array<{ startAt: Date; endAt: Date; blockScope?: string; zoneIds?: string[] }>} [blockingSessions]
 * @param {{ partySize?: number|null; blockRules?: Array<object>; allTables?: Array<object>; swapsByReservationId?: Map; proposedSwaps?: Array<object> }} [opts]
 *   partySize: tamaño del grupo (necesario para evaluar reglas de bloqueo con umbral).
 *   blockRules: reglas TableBlockRule del restaurante.
 *   allTables: lista completa de mesas (para resolver mesas vinculadas que no sean candidatas). Default: candidateTables.
 *   swapsByReservationId: sustituciones puntuales (ReservationTableSwap) de otras reservas gatillo activas, por reservation.id.
 *   proposedSwaps: sustituciones propuestas/persistidas SOLO si `candidateTables` es una única mesa gatillo explícita.
 * @returns {Array<typeof candidateTables[0]>} - subconjunto de candidateTables que está libre
 */
function getFreeTables(
  candidateTables,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken = null,
  blockingSessions = [],
  opts = {}
) {
  const { partySize = null, blockRules = [], allTables = candidateTables, swapsByReservationId = null, proposedSwaps = [] } = opts;
  const tableById = new Map(allTables.map((t) => [t.id, t]));
  const derivedBlockedIds = getDerivedBlockedTableIds(
    parsedReservations,
    parsedHolds,
    blockRules,
    slotStart,
    slotEnd,
    excludeHoldToken,
    swapsByReservationId
  );

  return candidateTables.filter((table) => {
    if (isTableBlockedBySessions(table, slotStart, slotEnd, blockingSessions)) return false;
    if (derivedBlockedIds.has(table.id)) return false;
    if (!isDirectlyFree(table.id, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, excludeHoldToken)) return false;
    if (
      hasLinkedTableConflict(
        table.id, partySize, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds,
        excludeHoldToken, blockingSessions, blockRules, derivedBlockedIds, tableById, proposedSwaps
      )
    ) return false;
    return true;
  });
}

/**
 * Cuántas mesas candidatas están libres para un slot dado. Ver getFreeTables
 * para el detalle de parámetros — mismo cálculo, solo retorna el total.
 * @returns {number} - cantidad de mesas libres
 */
function countFreeTables(
  candidateTables,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken = null,
  blockingSessions = [],
  opts = {}
) {
  return getFreeTables(
    candidateTables, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds,
    excludeHoldToken, blockingSessions, opts
  ).length;
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
 * @param {{ preferOpenEnded?: boolean; blockRules?: Array<object>; swapsByReservationId?: Map }} [opts]
 *   preferOpenEnded: true → prioriza mesas con más tiempo libre después del slot (ideal para walk-ins).
 *   blockRules: reglas TableBlockRule del restaurante (mesas vinculadas, bidireccional).
 *   swapsByReservationId: sustituciones puntuales (ReservationTableSwap) activas, por reservation.id.
 * @param {Array<{ startAt: Date; endAt: Date; blockScope?: string; zoneIds?: string[] }>} [blockingSessions]
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
  excludeHoldToken = null,
  { preferOpenEnded = false, blockRules = [], swapsByReservationId = null } = {},
  blockingSessions = []
) {
  const candidates = getCandidateTables(tables, partySize, null);
  const free = getFreeTables(
    candidates, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds,
    excludeHoldToken, blockingSessions, { partySize, blockRules, allTables: tables, swapsByReservationId }
  );

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
    // Walk-in / preferOpenEnded: priorizar mesa con más tiempo libre antes de la próxima reserva
    if (preferOpenEnded) {
      const gapA = msUntilNextReservation(a.id, slotEnd, parsedReservations);
      const gapB = msUntilNextReservation(b.id, slotEnd, parsedReservations);
      if (gapA !== gapB) return gapB - gapA; // más tiempo libre primero
    }
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
 * @param {Array<{ id?: string; tableId: string|null; startUtc: string; durationMinutes: number; partySize?: number }>} reservations
 * @param {number} bufferMs - se usa en la comparación, no en el mapeo
 * @returns {Array<{ id: string|null; tableId: string|null; start: Date; end: Date; partySize: number|null }>}
 */
function parseReservations(reservations) {
  return reservations.map((r) => ({
    id: r.id ?? null,
    tableId: r.tableId,
    start: new Date(r.startUtc),
    end: new Date(new Date(r.startUtc).getTime() + r.durationMinutes * 60000),
    partySize: r.partySize ?? null,
  }));
}

/**
 * Convierte array de holds raw a formato normalizado.
 * @param {Array<{ tableId: string; startUtc: string; durationMinutes: number; holdToken: string; partySize?: number }>} holds
 * @returns {Array<{ tableId: string; start: Date; end: Date; holdToken: string; partySize: number|null }>}
 */
function parseHolds(holds) {
  return holds.map((h) => ({
    tableId: h.tableId,
    start: new Date(h.startUtc),
    end: new Date(new Date(h.startUtc).getTime() + h.durationMinutes * 60000),
    holdToken: h.holdToken,
    partySize: h.partySize ?? null,
  }));
}

function getConflictingLinkedTableLabels(
  tableId,
  partySize,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken,
  blockingSessions,
  blockRules,
  tableById,
  proposedSwaps = [],
  swapsByReservationId = null
) {
  if (!blockRules?.length) return [];
  const requiredLinked = getRequiredLinkedTableIds(tableId, partySize, blockRules, proposedSwaps);
  if (requiredLinked.length === 0) return [];

  const derivedBlockedIds = getDerivedBlockedTableIds(
    parsedReservations,
    parsedHolds,
    blockRules,
    slotStart,
    slotEnd,
    excludeHoldToken,
    swapsByReservationId
  );

  return requiredLinked
    .filter((linkedId) => {
      const linkedTable = tableById.get(linkedId);
      if (linkedTable && isTableBlockedBySessions(linkedTable, slotStart, slotEnd, blockingSessions)) return true;
      if (derivedBlockedIds.has(linkedId)) return true;
      return !isDirectlyFree(linkedId, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, excludeHoldToken);
    })
    .map((id) => tableById.get(id)?.label || id);
}

/**
 * Igual que `getConflictingLinkedTableLabels`, pero retorna detalle suficiente para
 * ofrecer una resolución (mover la reserva que bloquea, o sustituir la mesa vinculada):
 * qué mesa está en conflicto, y — cuando el conflicto es una reserva u hold directo
 * sobre esa mesa vinculada — su id/token para poder reasignarla o excluirla.
 *
 * @returns {Array<{ tableId: string, tableLabel: string, reason: 'activity'|'reservation'|'hold'|'other_event', blockingReservationId: string|null, blockingHoldToken: string|null }>}
 */
function getLinkedTableConflictDetails(
  tableId,
  partySize,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken,
  blockingSessions,
  blockRules,
  tableById,
  swapsByReservationId = null,
  proposedSwaps = []
) {
  if (!blockRules?.length) return [];
  const requiredLinked = getRequiredLinkedTableIds(tableId, partySize, blockRules, proposedSwaps);
  if (requiredLinked.length === 0) return [];

  const derivedBlockedIds = getDerivedBlockedTableIds(
    parsedReservations,
    parsedHolds,
    blockRules,
    slotStart,
    slotEnd,
    excludeHoldToken,
    swapsByReservationId
  );

  const details = [];
  for (const linkedId of requiredLinked) {
    const linkedTable = tableById.get(linkedId);
    const tableLabel = linkedTable?.label || linkedId;

    if (linkedTable && isTableBlockedBySessions(linkedTable, slotStart, slotEnd, blockingSessions)) {
      details.push({ tableId: linkedId, tableLabel, reason: 'activity', blockingReservationId: null, blockingHoldToken: null });
      continue;
    }

    const directReservation = parsedReservations.find(
      (r) => r.tableId === linkedId && overlaps(slotStart, slotEnd, r.start, new Date(r.end.getTime() + bufferMs))
    );
    if (directReservation) {
      details.push({ tableId: linkedId, tableLabel, reason: 'reservation', blockingReservationId: directReservation.id ?? null, blockingHoldToken: null });
      continue;
    }

    const directHold = parsedHolds.find(
      (h) =>
        h.tableId === linkedId &&
        (!excludeHoldToken || h.holdToken !== excludeHoldToken) &&
        overlaps(slotStart, slotEnd, h.start, h.end)
    );
    if (directHold) {
      details.push({ tableId: linkedId, tableLabel, reason: 'hold', blockingReservationId: null, blockingHoldToken: directHold.holdToken });
      continue;
    }

    if (derivedBlockedIds.has(linkedId)) {
      details.push({ tableId: linkedId, tableLabel, reason: 'other_event', blockingReservationId: null, blockingHoldToken: null });
    }
  }
  return details;
}

function formatTableLabelList(labels) {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

/**
 * Mensaje de error legible cuando una mesa concreta no puede reservarse en un cupo.
 */
function buildTableBookingConflictMessage(
  table,
  partySize,
  slotStart,
  slotEnd,
  bufferMs,
  parsedReservations,
  parsedHolds,
  excludeHoldToken,
  blockingSessions,
  blockRules,
  allTables,
  proposedSwaps = [],
  swapsByReservationId = null
) {
  const tableById = new Map(allTables.map((t) => [t.id, t]));

  if (isTableBlockedBySessions(table, slotStart, slotEnd, blockingSessions)) {
    return 'Esa mesa no está disponible por una actividad en ese horario.';
  }

  const derivedBlockedIds = getDerivedBlockedTableIds(
    parsedReservations,
    parsedHolds,
    blockRules,
    slotStart,
    slotEnd,
    excludeHoldToken,
    swapsByReservationId
  );
  if (derivedBlockedIds.has(table.id)) {
    return 'Esa mesa está bloqueada por otra reserva en ese horario. Elige otra mesa o cambia la hora.';
  }

  if (!isDirectlyFree(table.id, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, excludeHoldToken)) {
    return 'Esa mesa ya está reservada en ese horario. Elige otra mesa o cambia la hora.';
  }

  const conflictingLabels = getConflictingLinkedTableLabels(
    table.id,
    partySize,
    slotStart,
    slotEnd,
    bufferMs,
    parsedReservations,
    parsedHolds,
    excludeHoldToken,
    blockingSessions,
    blockRules,
    tableById,
    proposedSwaps,
    swapsByReservationId
  );
  if (conflictingLabels.length > 0) {
    return `No se puede reservar ${table.label}: las mesas vinculadas ${formatTableLabelList(conflictingLabels)} tienen reservas en ese horario.`;
  }

  return 'Esa mesa no está disponible en ese horario. Elige otra mesa o cambia la hora.';
}

module.exports = {
  overlaps,
  getCandidateTables,
  getFreeTables,
  countFreeTables,
  pickTable,
  checkPacing,
  parseReservations,
  parseHolds,
  msUntilNextReservation,
  isDirectlyFree,
  getLinkedTableConflictDetails,
  buildTableBookingConflictMessage,
};
