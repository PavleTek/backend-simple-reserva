'use strict';

/**
 * Verifica que loadDaySnapshotsForRange (batch) produzca resultados idénticos
 * a llamar loadDaySnapshot día por día (lógica pre-optimización), para
 * findNextAvailableDateForSlug. Script de validación manual, no un test
 * automatizado — no se ejecuta en CI.
 *
 * Uso: node scripts/perf/verify-next-available.js
 */

const prisma = require('../../src/lib/prisma');
const { DateTime } = require('luxon');
const {
  loadDaySnapshot,
  loadDaySnapshotsForRange,
  computeAvailability,
} = require('../../src/services/slotEngine');
const { getEffectiveTimezone } = require('../../src/utils/timezone');
const { hasActiveAccess } = require('../../src/services/subscriptionService');

const SLUGS = [
  'perf-test-20-mesas',
  'perf-test-40-mesas',
  'perf-test-80-mesas',
  'perf-test-120-mesas',
];

async function oldWayFindNextAvailable(slug, { fromDateStr, partySize, zoneId }) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true, isDeleted: false },
    include: { organization: { include: { owner: { select: { country: true } } } } },
  });
  if (!restaurant) return { ok: false, error: 'not_found' };

  const access = await hasActiveAccess(restaurant.organizationId);
  if (!access) return { ok: true, nextDate: null, reason: 'subscription_expired' };

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const advanceDays = restaurant.advanceBookingLimitDays ?? 30;

  let cursor = DateTime.fromISO(fromDateStr, { zone: timezone }).plus({ days: 1 });
  const limitEnd = DateTime.now().setZone(timezone).plus({ days: advanceDays });

  const perDaySlotsCount = {};

  while (cursor.startOf('day') <= limitEnd.endOf('day')) {
    const dateStr = cursor.toFormat('yyyy-MM-dd');
    const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
    const result = computeAvailability(snapshot, {
      partySize,
      zoneId: zoneId || null,
      now: new Date(snapshot.serverNowUtc),
    });
    perDaySlotsCount[dateStr] = result.slots.map((s) => `${s.time}:${s.availableTables}`);
    if (result.slots.length > 0) {
      return { ok: true, nextDate: dateStr, slotsCount: result.slots.length, perDaySlotsCount };
    }
    cursor = cursor.plus({ days: 1 });
  }

  return { ok: true, nextDate: null, reason: 'no_future_availability', perDaySlotsCount };
}

async function newWayFindNextAvailable(slug, { fromDateStr, partySize, zoneId }) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true, isDeleted: false },
    include: { organization: { include: { owner: { select: { country: true } } } } },
  });
  if (!restaurant) return { ok: false, error: 'not_found' };

  const access = await hasActiveAccess(restaurant.organizationId);
  if (!access) return { ok: true, nextDate: null, reason: 'subscription_expired' };

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const advanceDays = restaurant.advanceBookingLimitDays ?? 30;

  let cursor = DateTime.fromISO(fromDateStr, { zone: timezone }).plus({ days: 1 });
  const limitEnd = DateTime.now().setZone(timezone).plus({ days: advanceDays });
  const dateStrs = [];
  while (cursor.startOf('day') <= limitEnd.endOf('day')) {
    dateStrs.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }

  const snapshots = await loadDaySnapshotsForRange(restaurant, { dateStrs, timezone });
  const perDaySlotsCount = {};

  for (const dateStr of dateStrs) {
    const snapshot = snapshots.get(dateStr);
    const result = computeAvailability(snapshot, {
      partySize,
      zoneId: zoneId || null,
      now: new Date(snapshot.serverNowUtc),
    });
    perDaySlotsCount[dateStr] = result.slots.map((s) => `${s.time}:${s.availableTables}`);
    if (result.slots.length > 0) {
      return { ok: true, nextDate: dateStr, slotsCount: result.slots.length, perDaySlotsCount };
    }
  }

  return { ok: true, nextDate: null, reason: 'no_future_availability', perDaySlotsCount };
}

async function main() {
  const today = DateTime.now().toFormat('yyyy-MM-dd');
  const fromDates = [today, DateTime.now().plus({ days: 3 }).toFormat('yyyy-MM-dd')];
  const partySizes = [2, 4, 8];
  const zoneIds = [null];

  let mismatches = 0;
  let comparisons = 0;

  for (const slug of SLUGS) {
    // Resolve some zoneIds for this restaurant to also test zone filtering.
    const restaurant = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true } });
    const zones = await prisma.zone.findMany({ where: { restaurantId: restaurant.id, isActive: true }, take: 1, select: { id: true } });
    const zoneIdsForThis = [null, ...(zones[0] ? [zones[0].id] : [])];

    for (const fromDateStr of fromDates) {
      for (const partySize of partySizes) {
        for (const zoneId of zoneIdsForThis) {
          comparisons += 1;
          const [oldResult, newResult] = await Promise.all([
            oldWayFindNextAvailable(slug, { fromDateStr, partySize, zoneId }),
            newWayFindNextAvailable(slug, { fromDateStr, partySize, zoneId }),
          ]);

          const oldKey = JSON.stringify(oldResult.perDaySlotsCount);
          const newKey = JSON.stringify(newResult.perDaySlotsCount);
          const same =
            oldResult.nextDate === newResult.nextDate &&
            oldResult.slotsCount === newResult.slotsCount &&
            oldResult.reason === newResult.reason &&
            oldKey === newKey;

          if (!same) {
            mismatches += 1;
            console.log(`\n[MISMATCH] slug=${slug} from=${fromDateStr} party=${partySize} zone=${zoneId}`);
            console.log('  OLD:', { nextDate: oldResult.nextDate, slotsCount: oldResult.slotsCount, reason: oldResult.reason });
            console.log('  NEW:', { nextDate: newResult.nextDate, slotsCount: newResult.slotsCount, reason: newResult.reason });
            for (const dateStr of Object.keys(oldResult.perDaySlotsCount)) {
              const o = JSON.stringify(oldResult.perDaySlotsCount[dateStr]);
              const n = JSON.stringify(newResult.perDaySlotsCount[dateStr] ?? null);
              if (o !== n) {
                console.log(`    day ${dateStr}: OLD=${o}  NEW=${n}`);
              }
            }
          } else {
            console.log(`[OK] slug=${slug} from=${fromDateStr} party=${partySize} zone=${zoneId} → nextDate=${newResult.nextDate} slots=${newResult.slotsCount}`);
          }
        }
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
