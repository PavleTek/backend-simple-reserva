const prisma = require('../lib/prisma');
const { ACTIVE_TABLE_STATUSES } = require('../lib/reservationStatuses');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  formatInTimezone,
  getDayOfWeekInTimezone,
} = require('../utils/timezone');
const { isCrossMidnightEnabled } = require('../lib/featureFlags');

function reservationIsWalkIn(r) {
  const n = (r.notes || '').trim().toLowerCase();
  const name = (r.customerName || '').trim();
  return n === 'walk-in' || name === 'Walk-in' || name === 'walk-in';
}

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

async function buildServiceView(restaurantId, dateParam) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      organization: { include: { owner: { select: { country: true } } } },
    },
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
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
    },
    pressure: {
      ...pressure,
      tablesTotal,
      tablesFree,
      ...pressureMetrics,
    },
    tables: tablesBrief,
    reservations: enriched,
  };
}

module.exports = {
  buildServiceView,
  reservationIsWalkIn,
};
