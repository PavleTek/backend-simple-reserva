const prisma = require('../lib/prisma');

/**
 * @param {'24h' | '7d' | '30d' | 'custom'} period
 * @param {string} [dateFrom] YYYY-MM-DD
 * @param {string} [dateTo] YYYY-MM-DD
 */
function resolvePeriodRanges(period, dateFrom, dateTo) {
  const now = new Date();

  if (period === 'custom' && dateFrom && dateTo) {
    const fromParts = String(dateFrom).slice(0, 10).split('-').map(Number);
    const toParts = String(dateTo).slice(0, 10).split('-').map(Number);
    if (fromParts.length !== 3 || toParts.length !== 3) {
      return { error: 'Formato de fecha inválido (usa YYYY-MM-DD)' };
    }
    const currentStart = new Date(Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2], 0, 0, 0, 0));
    const currentEnd = new Date(Date.UTC(toParts[0], toParts[1] - 1, toParts[2], 23, 59, 59, 999));
    if (currentStart >= currentEnd) {
      return { error: 'Rango de fechas inválido' };
    }
    const durationMs = currentEnd.getTime() - currentStart.getTime();
    const previousEnd = new Date(currentStart.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - durationMs);
    return {
      label: `${dateFrom} — ${dateTo}`,
      periodKey: 'custom',
      current: { gte: currentStart, lte: currentEnd },
      previous: { gte: previousStart, lte: previousEnd },
    };
  }

  const msDay = 24 * 60 * 60 * 1000;

  if (period === '24h') {
    const currentEnd = now;
    const currentStart = new Date(now.getTime() - msDay);
    const previousEnd = new Date(currentStart.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - msDay);
    return {
      label: 'Últimas 24 horas',
      periodKey: '24h',
      current: { gte: currentStart, lte: currentEnd },
      previous: { gte: previousStart, lte: previousEnd },
    };
  }

  const days = period === '30d' ? 30 : 7;
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - days * msDay);
  const previousEnd = new Date(currentStart.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - days * msDay);

  return {
    label: period === '30d' ? 'Últimos 30 días' : 'Últimos 7 días',
    periodKey: period === '30d' ? '30d' : '7d',
    current: { gte: currentStart, lte: currentEnd },
    previous: { gte: previousStart, lte: previousEnd },
  };
}

function changePercent(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function countDistinctBookingSessions(range, eventName) {
  const rows = await prisma.bookingEvent.findMany({
    where: { timestamp: range, eventName },
    select: { sessionId: true },
    distinct: ['sessionId'],
  });
  return rows.length;
}

async function countDistinctMarketingSessions(range, eventName) {
  const rows = await prisma.marketingEvent.findMany({
    where: { timestamp: range, eventName },
    select: { sessionId: true },
    distinct: ['sessionId'],
  });
  return rows.length;
}

async function metricPair(countFn) {
  const [current, previous] = await Promise.all([
    countFn('current'),
    countFn('previous'),
  ]);
  return { current, previous, changePercent: changePercent(current, previous) };
}

/**
 * @param {{ period?: string, dateFrom?: string, dateTo?: string }} query
 */
async function getDashboardOverview(query) {
  const period = query.period && ['24h', '7d', '30d', 'custom'].includes(query.period)
    ? query.period
    : '7d';

  const ranges = resolvePeriodRanges(period, query.dateFrom, query.dateTo);
  if (ranges.error) return { error: ranges.error, status: 400 };

  const { current, previous, label, periodKey } = ranges;
  const ts = (key) => (key === 'current' ? current : previous);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalRestaurants,
    totalActiveRestaurants,
    totalUsers,
    totalReservations,
    reservationsThisMonth,
    activeSubscriptions,
    reservationsCreated,
    bookingPageViews,
    bookingConfirmed,
    landingPageViews,
    landingCtaClicks,
    newOrganizations,
    reservationDaily,
  ] = await Promise.all([
    prisma.restaurant.count({ where: { isDeleted: false } }),
    prisma.restaurant.count({ where: { isActive: true, isDeleted: false } }),
    prisma.user.count(),
    prisma.reservation.count(),
    prisma.reservation.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.subscription.count({ where: { status: 'active' } }),
    metricPair((k) => prisma.reservation.count({ where: { createdAt: ts(k) } })),
    metricPair((k) => countDistinctBookingSessions(ts(k), 'booking.page_view')),
    metricPair((k) => countDistinctBookingSessions(ts(k), 'booking.confirmed')),
    metricPair((k) => countDistinctMarketingSessions(ts(k), 'marketing.page_view')),
    metricPair((k) => countDistinctMarketingSessions(ts(k), 'marketing.cta_click')),
    metricPair((k) =>
      prisma.restaurantOrganization.count({ where: { createdAt: ts(k), isDeleted: false } }),
    ),
    prisma.reservation.findMany({
      where: { createdAt: current },
      select: { createdAt: true },
    }),
  ]);

  const dayMap = new Map();
  for (const r of reservationDaily) {
    const day = r.createdAt.toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
  }
  const dailyReservations = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return {
    period: {
      key: periodKey,
      label,
      from: current.gte.toISOString(),
      to: current.lte.toISOString(),
      compareFrom: previous.gte.toISOString(),
      compareTo: previous.lte.toISOString(),
    },
    totals: {
      totalRestaurants,
      totalActiveRestaurants,
      totalUsers,
      totalReservations,
      reservationsThisMonth,
      activeSubscriptions,
    },
    periodMetrics: {
      reservationsCreated,
      bookingPageViews,
      bookingConfirmed,
      landingPageViews,
      landingCtaClicks,
      newOrganizations,
    },
    dailyReservations,
  };
}

module.exports = { getDashboardOverview, changePercent };
