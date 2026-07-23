'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const prisma = require('../../lib/prisma');
const { getEffectiveTimezone } = require('../../utils/timezone');
const {
  loadDaySnapshotsForRange,
  computeAvailability,
} = require('../slotEngine');
const { CONTEXT_DEFAULTS, STAGES } = require('./config');

/**
 * Glosario (ver docs/product/sugerencias.md):
 * - recibidas: createdAt en período
 * - programadas: businessDate en período
 * - activas: confirmed|arrived
 * - canceladas: status=cancelled con businessDate en período
 */

function toYmd(dt) {
  return dt.toFormat('yyyy-MM-dd');
}

function startOfWeekMonday(dt) {
  // Luxon weekday: 1=Mon … 7=Sun
  return dt.startOf('day').minus({ days: dt.weekday - 1 });
}

function isoWeekKey(dt) {
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function hashFingerprint(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function businessDateYmd(bd) {
  if (!bd) return null;
  if (bd instanceof Date) {
    return DateTime.fromJSDate(bd, { zone: 'utc' }).toFormat('yyyy-MM-dd');
  }
  return String(bd).slice(0, 10);
}

function dayFullyBlocked(dateStr, timezone, blockedSlots) {
  if (!blockedSlots?.length) return false;
  const dayStart = DateTime.fromISO(dateStr, { zone: timezone }).startOf('day');
  const dayEnd = dayStart.endOf('day');
  return blockedSlots.some((b) => {
    const start = DateTime.fromJSDate(new Date(b.startDatetime)).setZone(timezone);
    const end = DateTime.fromJSDate(new Date(b.endDatetime)).setZone(timezone);
    return start <= dayStart && end >= dayEnd;
  });
}

function scheduleActiveForDow(schedules, scheduleMode, dow) {
  const s = schedules.find((x) => x.dayOfWeek === dow && x.isActive);
  if (!s) return false;
  if (scheduleMode === 'service_periods') {
    const hasPeriod =
      (s.breakfastStartTime && s.breakfastEndTime) ||
      (s.lunchStartTime && s.lunchEndTime) ||
      (s.dinnerStartTime && s.dinnerEndTime);
    return Boolean(hasPeriod);
  }
  return Boolean(s.openTime && s.closeTime);
}

function buildConfigFingerprint(restaurant, schedules, tables, reservationWindows) {
  const schedulePart = schedules
    .filter((s) => s.isActive)
    .map((s) => ({
      d: s.dayOfWeek,
      o: s.openTime,
      c: s.closeTime,
      cn: s.closesNextDay,
      b: [s.breakfastStartTime, s.breakfastEndTime],
      l: [s.lunchStartTime, s.lunchEndTime],
      n: [s.dinnerStartTime, s.dinnerEndTime, s.dinnerEndsNextDay],
    }))
    .sort((a, b) => a.d - b.d);

  const tablesPart = {
    count: tables.filter((t) => t.isActive).length,
    caps: tables
      .filter((t) => t.isActive)
      .map((t) => [t.minCapacity, t.maxCapacity])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };

  const windowsPart =
    restaurant.reservationWindowMode === 'custom'
      ? (reservationWindows || [])
          .filter((w) => w.isActive !== false)
          .map((w) => ({ d: w.dayOfWeek, s: w.startTime, e: w.endTime, n: w.endsNextDay }))
          .sort((a, b) => a.d - b.d || String(a.s).localeCompare(String(b.s)))
      : [];

  return hashFingerprint({
    scheduleMode: restaurant.scheduleMode,
    schedule: schedulePart,
    tables: tablesPart,
    windows: windowsPart,
    advance: restaurant.advanceBookingLimitDays,
    notice: restaurant.minimumNoticeMinutes,
    acceptance: restaurant.bookingAcceptanceMode,
    interval: restaurant.slotIntervalMinutes,
    duration: restaurant.defaultSlotDurationMinutes,
    buffer: restaurant.bufferMinutesBetweenReservations,
    endPolicy: restaurant.reservationEndPolicy,
  });
}

function computeMaturityStage({
  onboardingCompletedAt,
  hasActiveSchedule,
  activeTableCount,
  daysSinceOnboarding,
  totalOnlineReceived,
  comparableWeeksCount,
  receivedInHistoryWeeks,
}) {
  if (!onboardingCompletedAt || !hasActiveSchedule || activeTableCount === 0) {
    return STAGES.CONFIGURACION;
  }
  if (
    daysSinceOnboarding < CONTEXT_DEFAULTS.maturityMinDays ||
    totalOnlineReceived < CONTEXT_DEFAULTS.maturityMinOnlineReceived
  ) {
    return STAGES.ACTIVACION;
  }
  if (
    comparableWeeksCount < CONTEXT_DEFAULTS.insightsMinComparableWeeks ||
    receivedInHistoryWeeks < CONTEXT_DEFAULTS.insightsMinReceived8Weeks
  ) {
    return STAGES.APRENDIZAJE;
  }
  return STAGES.INSIGHTS;
}

function classifyReservations(reservations, timezone, historyStart, historyEnd, recentStart) {
  const byBusinessDate = new Map(); // ymd -> list
  let receivedOnlineHistory = 0;
  let receivedManualHistory = 0;
  let receivedOnlineRecent = 0;
  let receivedManualRecent = 0;
  let cancelledInHistory = 0;
  const partySizes = [];

  for (const r of reservations) {
    const created = DateTime.fromJSDate(new Date(r.createdAt)).setZone(timezone);
    const ymd = businessDateYmd(r.businessDate) ||
      DateTime.fromJSDate(new Date(r.dateTime)).setZone(timezone).toFormat('yyyy-MM-dd');

    if (created >= historyStart && created <= historyEnd) {
      if (r.source === 'web') receivedOnlineHistory += 1;
      else if (r.source === 'manual') receivedManualHistory += 1;
      partySizes.push(r.partySize);
    }
    if (created >= recentStart && created <= historyEnd) {
      if (r.source === 'web') receivedOnlineRecent += 1;
      else if (r.source === 'manual') receivedManualRecent += 1;
    }

    if (ymd) {
      if (!byBusinessDate.has(ymd)) byBusinessDate.set(ymd, []);
      byBusinessDate.get(ymd).push(r);
      if (r.status === 'cancelled') cancelledInHistory += 1;
    }
  }

  return {
    byBusinessDate,
    receivedOnlineHistory,
    receivedManualHistory,
    receivedOnlineRecent,
    receivedManualRecent,
    cancelledInHistory,
    partySizes,
  };
}

function buildWeekStats({
  weekStart,
  timezone,
  schedules,
  scheduleMode,
  blockedSlots,
  byBusinessDate,
  receivedByCreatedWeek,
}) {
  const days = [];
  let openDays = 0;
  let programmed = 0;
  let covers = 0;
  let cancelled = 0;
  const hourBuckets = new Map(); // "dow|HH" -> count programmed

  for (let i = 0; i < 7; i++) {
    const day = weekStart.plus({ days: i });
    const ymd = toYmd(day);
    const dow = day.weekday === 7 ? 0 : day.weekday; // luxon Mon=1..Sun=7 → JS Sun=0
    const jsDow = day.weekday % 7; // Mon=1 → 1, Sun=7 → 0
    const open =
      scheduleActiveForDow(schedules, scheduleMode, jsDow) &&
      !dayFullyBlocked(ymd, timezone, blockedSlots);
    if (open) openDays += 1;

    const list = byBusinessDate.get(ymd) || [];
    programmed += list.length;
    for (const r of list) {
      covers += r.partySize || 0;
      if (r.status === 'cancelled') cancelled += 1;
      const hour = DateTime.fromJSDate(new Date(r.dateTime)).setZone(timezone).toFormat('HH');
      const key = `${jsDow}|${hour}`;
      hourBuckets.set(key, (hourBuckets.get(key) || 0) + 1);
    }
    days.push({ ymd, open, programmed: list.length });
  }

  const weekKey = isoWeekKey(weekStart);
  const received = receivedByCreatedWeek.get(weekKey) || { online: 0, manual: 0, total: 0 };

  return {
    weekKey,
    weekStartYmd: toYmd(weekStart),
    weekEndYmd: toYmd(weekStart.plus({ days: 6 })),
    openDays,
    programmed,
    covers,
    cancelled,
    receivedOnline: received.online,
    receivedManual: received.manual,
    receivedTotal: received.total,
    receivedPerOpenDay: openDays > 0 ? received.total / openDays : 0,
    programmedPerOpenDay: openDays > 0 ? programmed / openDays : 0,
    hourBuckets,
    days,
    comparable: openDays >= 1,
  };
}

/**
 * Construye el contexto de evaluación para un restaurante.
 * @param {string} restaurantId
 * @param {{ previousState?: object|null }} [opts]
 */
async function buildInsightContext(restaurantId, opts = {}) {
  const previousState = opts.previousState || null;

  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, isDeleted: false },
    include: {
      organization: { select: { owner: { select: { country: true } } } },
      schedules: true,
      reservationWindows: true,
      zones: { where: { isActive: true }, include: { tables: true } },
      menus: { select: { id: true }, take: 5 },
      blockedSlots: {
        where: {
          endDatetime: { gte: DateTime.now().minus({ weeks: 9 }).toJSDate() },
        },
      },
    },
  });

  if (!restaurant) return null;

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const now = DateTime.now().setZone(timezone);
  const todayYmd = toYmd(now);

  const tables = restaurant.zones.flatMap((z) => z.tables || []);
  const activeTables = tables.filter((t) => t.isActive);
  const activeDows = new Set();
  for (let dow = 0; dow <= 6; dow++) {
    if (scheduleActiveForDow(restaurant.schedules, restaurant.scheduleMode, dow)) {
      activeDows.add(dow);
    }
  }
  const hasActiveSchedule = activeDows.size > 0;
  const activeTableCount = activeTables.length;

  const historyStart = now.minus({ weeks: CONTEXT_DEFAULTS.historyWeeks }).startOf('day');
  const historyEnd = now.endOf('day');
  const recentStart = now.minus({ days: CONTEXT_DEFAULTS.recentReceivedDays }).startOf('day');
  const funnelStart = now.minus({ days: CONTEXT_DEFAULTS.funnelDays }).startOf('day');

  const historyStartUtc = historyStart.toUTC().toJSDate();
  const historyEndUtc = historyEnd.toUTC().toJSDate();

  const [reservations, totalOnlineEver, funnelEvents] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        restaurantId,
        OR: [
          { businessDate: { gte: historyStartUtc, lte: historyEndUtc } },
          { createdAt: { gte: historyStartUtc, lte: historyEndUtc } },
        ],
      },
      select: {
        id: true,
        status: true,
        source: true,
        partySize: true,
        dateTime: true,
        businessDate: true,
        createdAt: true,
        // Never select customerName/Phone/Email
      },
    }),
    prisma.reservation.count({
      where: { restaurantId, source: 'web' },
    }),
    prisma.bookingEvent.groupBy({
      by: ['eventName'],
      where: {
        restaurantId,
        timestamp: { gte: funnelStart.toUTC().toJSDate() },
        eventName: {
          in: [
            'booking.page_view',
            'booking.no_slots_shown',
            'booking.slots_empty_for_date',
            'booking.confirmed',
          ],
        },
      },
      _count: { _all: true },
    }),
  ]);

  // Distinct sessions with page_view
  const pageViewSessions = await prisma.bookingEvent.findMany({
    where: {
      restaurantId,
      eventName: 'booking.page_view',
      timestamp: { gte: funnelStart.toUTC().toJSDate() },
    },
    select: { sessionId: true },
    distinct: ['sessionId'],
  });

  const funnelCounts = Object.fromEntries(
    funnelEvents.map((e) => [e.eventName, e._count._all]),
  );
  const funnel = {
    hasAnyEvents: funnelEvents.length > 0 || pageViewSessions.length > 0,
    pageViewSessions: pageViewSessions.length,
    noSlotsShown:
      (funnelCounts['booking.no_slots_shown'] || 0) +
      (funnelCounts['booking.slots_empty_for_date'] || 0),
    confirmed: funnelCounts['booking.confirmed'] || 0,
    days: CONTEXT_DEFAULTS.funnelDays,
  };

  const classified = classifyReservations(
    reservations,
    timezone,
    historyStart,
    historyEnd,
    recentStart,
  );

  // Received by ISO week (createdAt)
  const receivedByCreatedWeek = new Map();
  for (const r of reservations) {
    const created = DateTime.fromJSDate(new Date(r.createdAt)).setZone(timezone);
    if (created < historyStart) continue;
    const key = isoWeekKey(created);
    if (!receivedByCreatedWeek.has(key)) {
      receivedByCreatedWeek.set(key, { online: 0, manual: 0, total: 0 });
    }
    const bucket = receivedByCreatedWeek.get(key);
    bucket.total += 1;
    if (r.source === 'web') bucket.online += 1;
    else if (r.source === 'manual') bucket.manual += 1;
  }

  // Party sizes
  const med = median(classified.partySizes) ?? CONTEXT_DEFAULTS.partySizeFallback;
  let minCap = 1;
  let maxCap = 20;
  if (activeTables.length) {
    minCap = Math.min(...activeTables.map((t) => t.minCapacity));
    maxCap = Math.max(...activeTables.map((t) => t.maxCapacity));
  }
  const medianClamped = Math.min(maxCap, Math.max(minCap, med));
  const partySizesToEval = [...new Set([medianClamped, CONTEXT_DEFAULTS.partySizeFallback].filter(
    (p) => p >= minCap && p <= maxCap,
  ))];
  if (partySizesToEval.length === 0) partySizesToEval.push(CONTEXT_DEFAULTS.partySizeFallback);

  // Future availability
  const futureDays = CONTEXT_DEFAULTS.futureAvailabilityDays;
  const dateStrs = [];
  for (let i = 0; i < futureDays; i++) {
    dateStrs.push(toYmd(now.plus({ days: i })));
  }

  const restaurantForSnapshot = {
    ...restaurant,
    tables: activeTables,
    zones: restaurant.zones,
  };

  let snapshots = new Map();
  let availabilityLoadFailed = false;
  try {
    snapshots = await loadDaySnapshotsForRange(restaurantForSnapshot, {
      dateStrs,
      timezone,
    });
  } catch (err) {
    availabilityLoadFailed = true;
    snapshots = new Map();
    // eslint-disable-next-line no-console
    console.warn('[insights] availability snapshot failed', {
      restaurantId,
      message: err?.message,
    });
  }

  const futureAvailability = [];
  let totalFutureSlots = 0;
  let openDaysWithSlots = 0;
  let fullyBlockedFutureDays = 0;

  for (const dateStr of dateStrs) {
    const jsDow = DateTime.fromISO(dateStr, { zone: timezone }).weekday % 7;
    const scheduleOpen = scheduleActiveForDow(
      restaurant.schedules,
      restaurant.scheduleMode,
      jsDow,
    );
    const blocked = dayFullyBlocked(dateStr, timezone, restaurant.blockedSlots);
    if (blocked) fullyBlockedFutureDays += 1;

    let bestSlots = 0;
    let reason = null;
    const snapshot = snapshots.get(dateStr);
    if (snapshot && scheduleOpen && !blocked) {
      for (const partySize of partySizesToEval) {
        const result = computeAvailability(snapshot, {
          partySize,
          now: now.toJSDate(),
        });
        const available = (result.slots || []).filter((s) => s.available).length;
        if (available > bestSlots) bestSlots = available;
        if (!reason && result.reason) reason = result.reason;
      }
    } else if (!scheduleOpen) {
      reason = 'no_schedule';
    } else if (blocked) {
      reason = 'blocked';
    }

    totalFutureSlots += bestSlots;
    if (scheduleOpen && !blocked && bestSlots > 0) openDaysWithSlots += 1;

    futureAvailability.push({
      date: dateStr,
      dayOfWeek: jsDow,
      scheduleOpen,
      blocked,
      freeSlots: bestSlots,
      reason,
    });
  }

  // Recent open days with slots (last 7 calendar days excluding today for "received" window)
  const lookbackDays = 7;
  let recentOpenDaysWithCapacity = 0;
  for (let i = 1; i <= lookbackDays; i++) {
    const d = now.minus({ days: i });
    const ymd = toYmd(d);
    const jsDow = d.weekday % 7;
    const open =
      scheduleActiveForDow(restaurant.schedules, restaurant.scheduleMode, jsDow) &&
      !dayFullyBlocked(ymd, timezone, restaurant.blockedSlots);
    if (open) recentOpenDaysWithCapacity += 1;
  }

  // Received online in last 7 days
  const last7Start = now.minus({ days: 7 }).startOf('day');
  let receivedOnlineLast7 = 0;
  let receivedManualLast7 = 0;
  for (const r of reservations) {
    const created = DateTime.fromJSDate(new Date(r.createdAt)).setZone(timezone);
    if (created < last7Start || created > historyEnd) continue;
    if (r.source === 'web') receivedOnlineLast7 += 1;
    else if (r.source === 'manual') receivedManualLast7 += 1;
  }

  // Weeks
  const currentWeekStart = startOfWeekMonday(now);
  const weeks = [];
  for (let w = 1; w <= CONTEXT_DEFAULTS.historyWeeks; w++) {
    const weekStart = currentWeekStart.minus({ weeks: w });
    weeks.push(
      buildWeekStats({
        weekStart,
        timezone,
        schedules: restaurant.schedules,
        scheduleMode: restaurant.scheduleMode,
        blockedSlots: restaurant.blockedSlots,
        byBusinessDate: classified.byBusinessDate,
        receivedByCreatedWeek,
      }),
    );
  }

  const fingerprint = buildConfigFingerprint(
    restaurant,
    restaurant.schedules,
    tables,
    restaurant.reservationWindows,
  );

  let configStableSince = previousState?.configStableSince
    ? new Date(previousState.configStableSince)
    : now.toJSDate();
  if (previousState?.configFingerprint && previousState.configFingerprint !== fingerprint) {
    configStableSince = now.toJSDate();
  } else if (!previousState?.configFingerprint) {
    configStableSince = now.toJSDate();
  }

  const configStableSinceDt = DateTime.fromJSDate(configStableSince).setZone(timezone);

  const comparableWeeks = weeks.filter((w) => {
    if (!w.comparable) return false;
    const weekStart = DateTime.fromISO(w.weekStartYmd, { zone: timezone });
    return configStableSinceDt <= weekStart;
  });

  const daysSinceOnboarding = restaurant.onboardingCompletedAt
    ? Math.floor(
        now.diff(DateTime.fromJSDate(new Date(restaurant.onboardingCompletedAt)).setZone(timezone), 'days')
          .days,
      )
    : 0;

  const maturityStage = computeMaturityStage({
    onboardingCompletedAt: restaurant.onboardingCompletedAt,
    hasActiveSchedule,
    activeTableCount,
    daysSinceOnboarding,
    totalOnlineReceived: totalOnlineEver,
    comparableWeeksCount: comparableWeeks.length,
    receivedInHistoryWeeks: classified.receivedOnlineHistory + classified.receivedManualHistory,
  });

  const missingProfile = [];
  if (!restaurant.logoUrl) missingProfile.push('logo');
  if (!restaurant.description?.trim()) missingProfile.push('descripcion');
  if (!restaurant.address?.trim()) missingProfile.push('direccion');
  if (!restaurant.phone?.trim() && !restaurant.bookingContactWhatsapp?.trim()) {
    missingProfile.push('contacto');
  }
  if (!restaurant.menus?.length && !restaurant.menuPdfUrl) missingProfile.push('menu');

  const bookingBase =
    process.env.BOOKING_BASE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'https://simplereserva.com';
  const publicBookingUrl = `${String(bookingBase).replace(/\/$/, '')}/restaurant/${restaurant.slug}`;

  const checklist = {
    profileComplete: missingProfile.length === 0,
    hasSchedule: hasActiveSchedule,
    hasTables: activeTableCount > 0,
    hasPublicPage: Boolean(restaurant.slug),
    hasOnlineReservation: totalOnlineEver > 0,
    onboardingComplete: Boolean(restaurant.onboardingCompletedAt),
  };

  return {
    restaurantId,
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      dataVersion: restaurant.dataVersion,
      onboardingCompletedAt: restaurant.onboardingCompletedAt,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes,
      requireEmail: restaurant.requireEmail,
      requirePhoneNumber: restaurant.requirePhoneNumber,
      scheduleMode: restaurant.scheduleMode,
      timezone,
    },
    publicBookingUrl,
    now: now.toJSDate(),
    todayYmd,
    timezone,
    hasActiveSchedule,
    activeTableCount,
    activeScheduleDayCount: activeDows.size,
    missingProfile,
    checklist,
    partySizesToEval,
    medianPartySize: medianClamped,
    futureAvailability,
    totalFutureSlots,
    availabilityLoadFailed,
    openDaysWithSlots,
    fullyBlockedFutureDays,
    recentOpenDaysWithCapacity,
    receivedOnlineLast7,
    receivedManualLast7,
    totalOnlineEver,
    funnel,
    weeks,
    comparableWeeks,
    lastCompleteWeek: weeks[0] || null,
    fingerprint,
    configStableSince,
    maturityStage,
    metrics: {
      receivedOnlineHistory: classified.receivedOnlineHistory,
      receivedManualHistory: classified.receivedManualHistory,
      cancelledInHistory: classified.cancelledInHistory,
    },
  };
}

module.exports = {
  buildInsightContext,
  computeMaturityStage,
  buildConfigFingerprint,
  scheduleActiveForDow,
  dayFullyBlocked,
  median,
  startOfWeekMonday,
  isoWeekKey,
  toYmd,
};
