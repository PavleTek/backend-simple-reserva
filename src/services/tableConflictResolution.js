'use strict';

/**
 * services/tableConflictResolution.js
 *
 * A partir de un conflicto de mesas vinculadas (ver slotEngine/capacity.js
 * `getLinkedTableConflictDetails`), arma las opciones de resolución que se
 * ofrecen al staff en vez de un error genérico:
 *
 * - moveSuggestions: mesas libres donde mover la reserva que ocupa la mesa
 *   vinculada (solo si esa reserva aún no llegó — a un cliente ya sentado no
 *   se le puede mover de mesa a mitad de la comida).
 * - swapSuggestions: mesas libres para usar en vez de la mesa vinculada
 *   conflictiva, solo para esta reserva puntual (no cambia TableBlockRule).
 */

const prisma = require('../lib/prisma');
const { getAvailableTablesForSlot } = require('./availableTablesForSlot');
const { formatInTimezone } = require('../utils/timezone');
const { loadSwapsByReservationId, normalizeTableSwaps } = require('./reservationTableSwaps');

const MAX_SUGGESTIONS_PER_CONFLICT = 5;

/**
 * @param {Object} params
 * @param {string} params.restaurantId
 * @param {object} params.restaurant
 * @param {string} params.timezone
 * @param {Array<{tableId: string, tableLabel: string, reason: string, blockingReservationId: string|null, blockingHoldToken: string|null}>} params.conflictDetails
 * @param {string} params.eventDateStr - fecha (yyyy-MM-dd) del cupo del evento, para buscar sustitutos.
 * @param {string} params.eventTimeStr - hora (HH:mm) del cupo del evento.
 * @param {number} params.eventPartySize
 * @param {string[]} params.excludeTableIdsForSwap - mesa gatillo + todas sus mesas vinculadas por defecto.
 * @returns {Promise<Array<object>>}
 */
async function buildTableConflictResolutions({
  restaurantId,
  restaurant,
  timezone,
  conflictDetails,
  eventDateStr,
  eventTimeStr,
  eventPartySize,
  excludeTableIdsForSwap,
}) {
  const conflicts = [];

  for (const detail of conflictDetails) {
    const entry = {
      tableId: detail.tableId,
      tableLabel: detail.tableLabel,
      reason: detail.reason,
      blockingReservation: null,
      moveSuggestions: [],
      swapSuggestions: [],
    };

    if (detail.reason === 'reservation' && detail.blockingReservationId) {
      const blocking = await prisma.reservation.findUnique({
        where: { id: detail.blockingReservationId },
        select: { id: true, customerName: true, partySize: true, dateTime: true, status: true },
      });
      if (blocking) {
        const canMove = blocking.status !== 'arrived';
        entry.blockingReservation = {
          id: blocking.id,
          customerName: blocking.customerName,
          partySize: blocking.partySize,
          dateTime: blocking.dateTime,
          canMove,
        };
        if (canMove) {
          const moveResult = await getAvailableTablesForSlot({
            restaurantId,
            restaurant,
            timezone,
            dateStr: formatInTimezone(blocking.dateTime, timezone, 'yyyy-MM-dd'),
            timeStr: formatInTimezone(blocking.dateTime, timezone, 'HH:mm'),
            partySize: blocking.partySize,
            excludeReservationId: blocking.id,
          });
          entry.moveSuggestions = (moveResult.tables || []).slice(0, MAX_SUGGESTIONS_PER_CONFLICT);
        }
      }
    }

    const swapResult = await getAvailableTablesForSlot({
      restaurantId,
      restaurant,
      timezone,
      dateStr: eventDateStr,
      timeStr: eventTimeStr,
      partySize: eventPartySize,
      ignoreCapacity: true,
      excludeTableIds: excludeTableIdsForSwap,
    });
    entry.swapSuggestions = (swapResult.tables || []).slice(0, MAX_SUGGESTIONS_PER_CONFLICT);

    conflicts.push(entry);
  }

  return conflicts;
}

module.exports = {
  buildTableConflictResolutions,
  loadSwapsByReservationId,
  normalizeTableSwaps,
};
