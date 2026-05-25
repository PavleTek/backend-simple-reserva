'use strict';

const prisma = require('../lib/prisma');
const { resolveDuration } = require('./slotEngine/index');
const {
  countFreeTables,
  getCandidateTables,
  parseReservations,
  parseHolds,
} = require('./slotEngine/capacity');
const { sortFreeTablesForUi } = require('../lib/tableAssignment');
const { ACTIVE_TABLE_STATUSES } = require('../lib/reservationStatuses');
const { parseInTimezone } = require('../utils/timezone');

function dayLookbackMs(defaultSlotDurationMinutes, durationRules = []) {
  const maxDuration = durationRules.reduce(
    (max, r) => Math.max(max, r.durationMinutes),
    defaultSlotDurationMinutes ?? 60,
  );
  return Math.max(maxDuration, 12 * 60) * 60000;
}

/**
 * Mesas libres para un cupo — misma lógica que al crear reserva (slotEngine + holds + lookback).
 */
async function getAvailableTablesForSlot({
  restaurantId,
  restaurant,
  timezone,
  dateStr,
  timeStr,
  partySize,
  excludeReservationId = null,
}) {
  const size = partySize;
  const dateTime = parseInTimezone(dateStr, timeStr, timezone);
  if (isNaN(dateTime.getTime())) {
    return { tables: [], invalid: true };
  }

  const durationRules = await prisma.durationRule.findMany({
    where: { restaurantId },
  });
  const duration = resolveDuration(restaurant, size, durationRules);
  const slotEnd = new Date(dateTime.getTime() + duration * 60000);
  const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;

  const allTables = await prisma.restaurantTable.findMany({
    where: {
      isActive: true,
      minCapacity: { lte: size },
      maxCapacity: { gte: size },
      zone: { restaurantId, isActive: true },
    },
    include: { zone: { select: { id: true, name: true, sortOrder: true } } },
  });

  if (allTables.length === 0) {
    return { tables: [] };
  }

  const lb = dayLookbackMs(restaurant.defaultSlotDurationMinutes, durationRules);
  const windowStart = new Date(dateTime.getTime() - lb);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

  const whereReservations = {
    restaurantId,
    status: { in: ACTIVE_TABLE_STATUSES },
    dateTime: { gte: windowStart, lte: dayEnd },
  };
  if (excludeReservationId) {
    whereReservations.id = { not: excludeReservationId };
  }

  const [dayReservations, blockedSlots, activeHolds] = await Promise.all([
    prisma.reservation.findMany({
      where: whereReservations,
      select: { id: true, tableId: true, dateTime: true, durationMinutes: true },
    }),
    prisma.blockedSlot.findMany({
      where: {
        restaurantId,
        startDatetime: { lt: slotEnd },
        endDatetime: { gt: dateTime },
      },
    }),
    restaurant.holdsEnabled
      ? prisma.reservationHold.findMany({
          where: {
            restaurantId,
            status: 'active',
            expiresAt: { gt: new Date() },
            dateTime: {
              gte: new Date(dateTime.getTime() - 4 * 60 * 60000),
              lte: new Date(dateTime.getTime() + 4 * 60 * 60000),
            },
          },
          select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
        })
      : [],
  ]);

  if (blockedSlots.length > 0) {
    return { tables: [], blocked: true };
  }

  const reservationsRaw = dayReservations.map((r) => ({
    tableId: r.tableId,
    startUtc: r.dateTime.toISOString(),
    durationMinutes: r.durationMinutes,
  }));
  const holdsRaw = activeHolds.map((h) => ({
    tableId: h.tableId,
    startUtc: h.dateTime.toISOString(),
    durationMinutes: h.durationMinutes,
    holdToken: h.holdToken,
  }));

  const parsedRes = parseReservations(reservationsRaw);
  const parsedHolds = parseHolds(holdsRaw);

  const tablesMapped = allTables.map((t) => ({
    id: t.id,
    zoneId: t.zone.id,
    minCapacity: t.minCapacity,
    maxCapacity: t.maxCapacity,
    sortOrder: t.sortOrder ?? 0,
    zoneSortOrder: t.zone.sortOrder ?? 0,
    zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
    label: t.label,
    zoneName: t.zone.name,
  }));

  const candidates = getCandidateTables(tablesMapped, size, null);
  const freeTables = [];
  for (const table of candidates) {
    const free = countFreeTables(
      [{ id: table.id, zoneId: table.zoneId, minCapacity: table.minCapacity, maxCapacity: table.maxCapacity }],
      dateTime,
      slotEnd,
      bufferMs,
      parsedRes,
      parsedHolds,
      null,
    );
    if (free > 0) {
      const full = allTables.find((t) => t.id === table.id);
      if (full) freeTables.push(full);
    }
  }

  const ordered = sortFreeTablesForUi(freeTables, size, null);
  return {
    tables: ordered.map((table) => ({
      id: table.id,
      label: table.label,
      zoneName: table.zone.name,
    })),
  };
}

module.exports = {
  getAvailableTablesForSlot,
  dayLookbackMs,
};
