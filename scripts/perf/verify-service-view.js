'use strict';

/**
 * Verifica que buildServiceView (con groupBy acotado a teléfonos del día +
 * Map de reservas por mesa) produzca el mismo resultado que la versión
 * pre-optimización (groupBy sobre todo el historial + filter por mesa).
 * Script de validación manual, no se ejecuta en CI.
 *
 * Uso: node scripts/perf/verify-service-view.js
 */

const prisma = require('../../src/lib/prisma');
const { DateTime } = require('luxon');
const { ACTIVE_TABLE_STATUSES } = require('../../src/lib/reservationStatuses');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  formatInTimezone,
  getDayOfWeekInTimezone,
} = require('../../src/utils/timezone');
const { isCrossMidnightEnabled } = require('../../src/lib/featureFlags');
const { buildServiceView, reservationIsWalkIn } = require('../../src/services/serviceView');

const SLUGS = [
  'perf-test-20-mesas',
  'perf-test-40-mesas',
  'perf-test-80-mesas',
  'perf-test-120-mesas',
];

// ─── Copia de las funciones de pressure, tal cual en serviceView.js (no exportadas) ──

function roundToSlotMinutes(date, minutes = 15) {
  const d = new Date(date);
  const m = d.getMinutes();
  const rounded = Math.floor(m / minutes) * minutes;
  d.setMinutes(rounded, 0, 0);
  return d;
}

function buildPressure(reservations, now, timezone, windowMinutes = 60) {
  const windowEnd = new Date(now.getTime() + windowMinutes * 60000);
  const active = reservations.filter(
    (r) =>
      ACTIVE_TABLE_STATUSES.includes(r.status) &&
      new Date(r.dateTime) <= windowEnd &&
      new Date(r.dateTime).getTime() + (r.durationMinutes || 90) * 60000 >= now.getTime(),
  );

  let covers = 0;
  let count = 0;
  for (const r of active) {
    if (new Date(r.dateTime) >= now && new Date(r.dateTime) <= windowEnd) {
      covers += r.partySize || 0;
      count += 1;
    }
  }

  const slots = [];
  const slotStart = roundToSlotMinutes(now);
  for (let i = 0; i < 4; i++) {
    const start = new Date(slotStart.getTime() + i * 15 * 60000);
    const end = new Date(start.getTime() + 15 * 60000);
    let slotCovers = 0;
    let slotRes = 0;
    for (const r of reservations) {
      if (!ACTIVE_TABLE_STATUSES.includes(r.status)) continue;
      const rStart = new Date(r.dateTime);
      const rEnd = new Date(rStart.getTime() + (r.durationMinutes || 90) * 60000);
      if (rStart < end && rEnd > start) {
        slotCovers += r.partySize || 0;
        if (rStart >= start && rStart < end) slotRes += 1;
      }
    }
    slots.push({
      start: start.toISOString(),
      label: formatInTimezone(start, timezone, 'HH:mm'),
      covers: slotCovers,
      reservations: slotRes,
    });
  }

  return {
    nextHourCovers: covers,
    nextHourReservations: count,
    slots,
  };
}

function computePressureLevel({ tablesTotal, tablesFree, nextHourCovers, pacingMaxCovers }) {
  if (tablesTotal <= 0) {
    return { level: 'calm', label: 'TRANQUILO' };
  }
  const occupied = tablesTotal - tablesFree;
  const occupancyPct = (occupied / tablesTotal) * 100;
  const coverCap = pacingMaxCovers || tablesTotal * 4;
  const coverPct = coverCap > 0 ? (nextHourCovers / coverCap) * 100 : 0;
  const stress = Math.max(occupancyPct, coverPct);

  if (stress > 100) return { level: 'overbook', label: 'SOBRECARGA' };
  if (stress >= 85) return { level: 'saturated', label: 'SATURADO' };
  if (stress >= 50) return { level: 'active', label: 'ACTIVO' };
  return { level: 'calm', label: 'TRANQUILO' };
}

// ─── Versión OLD (pre-optimización): groupBy sin acotar + filter por mesa ───

async function oldBuildServiceView(restaurantId, dateParam) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { organization: { include: { owner: { select: { country: true } } } } },
  });
  if (!restaurant) return null;

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const nowTZ = nowInTimezone(timezone);
  const todayLocal = nowTZ.toFormat('yyyy-MM-dd');
  const dateStr = dateParam || todayLocal;
  const dayStart = parseInTimezone(dateStr, '00:00', timezone);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);
  const businessDateVal = new Date(`${dateStr}T12:00:00.000Z`);

  const dateWhere = isCrossMidnightEnabled()
    ? {
        OR: [
          { businessDate: businessDateVal },
          { businessDate: null, dateTime: { gte: dayStart, lte: dayEnd } },
        ],
      }
    : { dateTime: { gte: dayStart, lte: dayEnd } };

  const [reservations, zones, pacingRules, phoneCounts] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        restaurantId,
        ...dateWhere,
        status: { in: ['confirmed', 'arrived', 'completed', 'no_show', 'cancelled'] },
      },
      include: { table: { select: { id: true, label: true } } },
      orderBy: { dateTime: 'asc' },
    }),
    prisma.zone.findMany({
      where: { restaurantId, isActive: true },
      include: { tables: { where: { isActive: true } } },
    }),
    prisma.pacingRule.findMany({ where: { restaurantId } }),
    prisma.reservation.groupBy({
      by: ['customerPhone'],
      where: {
        restaurantId,
        customerPhone: { not: null },
        status: { in: ['confirmed', 'arrived', 'completed'] },
      },
      _count: { id: true },
    }),
  ]);

  const visitCountByPhone = new Map();
  for (const row of phoneCounts) {
    const phone = row.customerPhone?.replace(/\s/g, '');
    if (phone) visitCountByPhone.set(phone, row._count.id);
  }

  const isToday = dateStr === todayLocal;
  const now = isToday ? nowTZ.toJSDate() : dayStart;
  const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;

  let tablesTotal = 0;
  let tablesFree = 0;
  const tablesBrief = [];

  for (const zone of zones) {
    for (const table of zone.tables) {
      tablesTotal += 1;
      const tableReservations = reservations.filter(
        (r) => r.tableId === table.id && ACTIVE_TABLE_STATUSES.includes(r.status),
      );
      let occupied = false;
      for (const r of tableReservations) {
        const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
        if (now >= r.dateTime && now < rEnd) {
          occupied = true;
          break;
        }
        if (reservationIsWalkIn(r) && now >= r.dateTime) {
          occupied = true;
          break;
        }
      }
      if (!occupied) tablesFree += 1;
      tablesBrief.push({
        id: table.id,
        label: table.label,
        zoneName: zone.name,
        minCapacity: table.minCapacity,
        maxCapacity: table.maxCapacity,
        free: !occupied,
      });
    }
  }

  const dayOfWeek = getDayOfWeekInTimezone(now, timezone);
  const pacingForDay =
    pacingRules.find((p) => p.dayOfWeek === dayOfWeek) ||
    pacingRules.find((p) => p.dayOfWeek == null) ||
    null;
  const pacingMaxCovers = pacingForDay?.maxCoversPerSlot ?? null;

  const operationalReservations = reservations.filter((r) =>
    ['confirmed', 'arrived'].includes(r.status),
  );
  const pressureMetrics = buildPressure(operationalReservations, now, timezone);
  const pressure = computePressureLevel({
    tablesTotal,
    tablesFree,
    nextHourCovers: pressureMetrics.nextHourCovers,
    pacingMaxCovers,
  });

  const enriched = reservations.map((r) => {
    const phone = r.customerPhone?.replace(/\s/g, '') || null;
    const visitCount = phone ? visitCountByPhone.get(phone) || 0 : 0;
    const notesLower = (r.notes || '').toLowerCase();
    return {
      id: r.id,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      customerEmail: r.customerEmail,
      partySize: r.partySize,
      dateTime: r.dateTime.toISOString(),
      durationMinutes: r.durationMinutes,
      status: r.status,
      source: r.source,
      notes: r.notes,
      table: r.table,
      walkIn: reservationIsWalkIn(r),
      repeatVisits: reservationIsWalkIn(r) ? 0 : visitCount > 1 ? visitCount : 0,
      hasNote: Boolean(r.notes && r.notes.trim() && !reservationIsWalkIn(r)),
      hasAllergy: notesLower.includes('alerg') || notesLower.includes('allergy'),
      hasOccasion:
        notesLower.includes('cumple') ||
        notesLower.includes('anivers') ||
        notesLower.includes('ocasion'),
    };
  });

  return {
    date: dateStr,
    timezone,
    now: now.toISOString(),
    isToday,
    restaurant: { id: restaurant.id, name: restaurant.name },
    pressure: { ...pressure, tablesTotal, tablesFree, ...pressureMetrics },
    tables: tablesBrief,
    reservations: enriched,
  };
}

async function main() {
  const today = DateTime.now().toFormat('yyyy-MM-dd');
  const dates = [today, DateTime.now().plus({ days: 1 }).toFormat('yyyy-MM-dd')];

  let mismatches = 0;
  let comparisons = 0;

  for (const slug of SLUGS) {
    const restaurant = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true } });
    if (!restaurant) {
      console.log(`[SKIP] ${slug} no encontrado`);
      continue;
    }

    for (const dateStr of dates) {
      comparisons += 1;
      const [oldResult, newResult] = await Promise.all([
        oldBuildServiceView(restaurant.id, dateStr),
        buildServiceView(restaurant.id, dateStr),
      ]);

      // `now` depende del instante de ejecución de cada llamada; se compara todo
      // lo demás y se tolera un pequeño desfase en `now`/`pressure.slots`.
      const oldForCompare = { ...oldResult, now: undefined, pressure: { ...oldResult.pressure, slots: undefined } };
      const newForCompare = { ...newResult, now: undefined, pressure: { ...newResult.pressure, slots: undefined } };

      const oldKey = JSON.stringify(oldForCompare);
      const newKey = JSON.stringify(newForCompare);

      if (oldKey !== newKey) {
        mismatches += 1;
        console.log(`\n[MISMATCH] slug=${slug} date=${dateStr}`);
        console.log('  OLD tablesFree:', oldResult.pressure.tablesFree, 'reservations:', oldResult.reservations.length);
        console.log('  NEW tablesFree:', newResult.pressure.tablesFree, 'reservations:', newResult.reservations.length);
        for (let i = 0; i < Math.max(oldResult.reservations.length, newResult.reservations.length); i++) {
          const o = JSON.stringify(oldResult.reservations[i]);
          const n = JSON.stringify(newResult.reservations[i]);
          if (o !== n) console.log(`    reservation[${i}]: OLD=${o}\n                  NEW=${n}`);
        }
        for (let i = 0; i < Math.max(oldResult.tables.length, newResult.tables.length); i++) {
          const o = JSON.stringify(oldResult.tables[i]);
          const n = JSON.stringify(newResult.tables[i]);
          if (o !== n) console.log(`    table[${i}]: OLD=${o}  NEW=${n}`);
        }
      } else {
        console.log(`[OK] slug=${slug} date=${dateStr} → tablesFree=${newResult.pressure.tablesFree}/${newResult.pressure.tablesTotal} reservations=${newResult.reservations.length}`);
      }
    }
  }

  console.log(`\n${comparisons - mismatches}/${comparisons} comparaciones idénticas.`);
  await prisma.$disconnect();
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
