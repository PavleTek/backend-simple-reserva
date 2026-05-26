'use strict';

const { parseInTimezone } = require('./timezone');
const { isCrossMidnightEnabled } = require('../lib/featureFlags');

/**
 * Filtro Prisma para reservas de un día calendario en la TZ del restaurante.
 * Alineado con GET /api/restaurant/:id/reservations?date=YYYY-MM-DD
 *
 * @param {string} restaurantId
 * @param {string} dateYmd - YYYY-MM-DD
 * @param {string} timezone - IANA
 * @param {{ status?: string }} [extra]
 * @returns {object}
 */
function buildReservationDayWhere(restaurantId, dateYmd, timezone, extra = {}) {
  const start = parseInTimezone(dateYmd, '00:00', timezone);
  const end = parseInTimezone(dateYmd, '23:59', timezone);
  const businessDateVal = new Date(`${dateYmd}T12:00:00.000Z`);

  const where = {
    restaurantId,
    ...extra,
  };

  if (isCrossMidnightEnabled()) {
    where.OR = [
      { businessDate: businessDateVal },
      { businessDate: null, dateTime: { gte: start, lte: end } },
    ];
  } else {
    where.dateTime = { gte: start, lte: end };
  }

  return where;
}

module.exports = { buildReservationDayWhere };
