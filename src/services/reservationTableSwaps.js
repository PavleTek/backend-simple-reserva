'use strict';

/**
 * services/reservationTableSwaps.js
 *
 * Utilidades de bajo nivel para ReservationTableSwap (carga + validación).
 * Vive separado de tableConflictResolution.js porque ese módulo depende de
 * availableTablesForSlot.js -> slotEngine/index.js, y slotEngine/index.js
 * necesita `loadSwapsByReservationId` para el cómputo de disponibilidad
 * pública. Mantener este archivo sin dependencias del slot engine evita
 * un require circular.
 */

const prisma = require('../lib/prisma');

/**
 * Carga los swaps activos (ReservationTableSwap) de un conjunto de reservas y los
 * agrupa por reservationId — formato que espera `getDerivedBlockedTableIds`/`applyBlockedStatus`.
 *
 * @param {string[]} reservationIds
 * @returns {Promise<Map<string, Array<{originalTableId: string, substituteTableId: string}>>>}
 */
async function loadSwapsByReservationId(reservationIds) {
  const swapsByReservationId = new Map();
  if (!reservationIds?.length) return swapsByReservationId;

  const rows = await prisma.reservationTableSwap.findMany({
    where: { reservationId: { in: reservationIds } },
    select: { reservationId: true, originalTableId: true, substituteTableId: true },
  });
  for (const row of rows) {
    const list = swapsByReservationId.get(row.reservationId) || [];
    list.push(row);
    swapsByReservationId.set(row.reservationId, list);
  }
  return swapsByReservationId;
}

/**
 * Valida la forma de `tableSwaps` recibido del cliente y lo normaliza.
 * Lanza un mensaje de error simple (para envolver en ValidationError) si algo no calza.
 *
 * @param {unknown} rawSwaps
 * @param {Array<{id: string}>} allTables - mesas activas del restaurante
 * @param {string} triggerTableId
 * @returns {Array<{originalTableId: string, substituteTableId: string}>}
 */
function normalizeTableSwaps(rawSwaps, allTables, triggerTableId) {
  if (rawSwaps == null) return [];
  if (!Array.isArray(rawSwaps)) throw new Error('tableSwaps debe ser una lista');

  const tableIds = new Set(allTables.map((t) => t.id));
  return rawSwaps.map((swap) => {
    const originalTableId = typeof swap?.originalTableId === 'string' ? swap.originalTableId : null;
    const substituteTableId = typeof swap?.substituteTableId === 'string' ? swap.substituteTableId : null;
    if (!originalTableId || !substituteTableId) {
      throw new Error('Cada sustitución requiere originalTableId y substituteTableId');
    }
    if (substituteTableId === originalTableId || substituteTableId === triggerTableId) {
      throw new Error('La mesa sustituta debe ser distinta de la mesa original y de la mesa del evento');
    }
    if (!tableIds.has(substituteTableId)) {
      throw new Error('La mesa sustituta indicada no existe en este restaurante');
    }
    return { originalTableId, substituteTableId };
  });
}

module.exports = {
  loadSwapsByReservationId,
  normalizeTableSwaps,
};
