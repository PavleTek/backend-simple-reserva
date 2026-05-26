const prisma = require('../lib/prisma');
const { parseUtcDateRange } = require('../lib/parseUtcDateRange');

const REGISTER_CTA_SUFFIX = '.register';

async function countDistinctSessions(where, eventName, extraWhere = {}) {
  const sessions = await prisma.marketingEvent.findMany({
    where: { ...where, eventName, ...extraWhere },
    select: { sessionId: true },
    distinct: ['sessionId'],
  });
  return sessions.length;
}

/**
 * @param {{ dateFrom?: string, dateTo?: string, pagePath?: string }} query
 */
async function getMarketingAnalytics(query) {
  const { dateFrom, dateTo, pagePath } = query;
  const range = parseUtcDateRange(dateFrom, dateTo, 30);
  if (range.error) return { error: range.error, status: 400 };

  const { from, to } = range;
  const where = { timestamp: { gte: from, lte: to } };
  const pagePathFilter = pagePath && String(pagePath).trim();
  if (pagePathFilter) {
    where.pagePath = pagePathFilter;
  }

  const scroll50Where = {
    properties: { path: ['percent'], equals: 50 },
  };

  const registerCtaWhere = {
    OR: [
      { ctaId: { endsWith: REGISTER_CTA_SUFFIX } },
      { properties: { path: ['isRegister'], equals: true } },
    ],
  };

  const [pageViews, scroll50, anyCta, registerCta] = await Promise.all([
    countDistinctSessions(where, 'marketing.page_view'),
    countDistinctSessions(where, 'marketing.scroll_depth', scroll50Where),
    countDistinctSessions(where, 'marketing.cta_click'),
    countDistinctSessions(where, 'marketing.cta_click', registerCtaWhere),
  ]);

  const funnelCounts = [
    { step: 'marketing.page_view', count: pageViews },
    { step: 'marketing.scroll_depth (50%)', count: scroll50 },
    { step: 'marketing.cta_click', count: anyCta },
    { step: 'marketing.cta_click (registro)', count: registerCta },
  ];

  const funnel = funnelCounts.map((item, i) => {
    const prevCount = i > 0 ? funnelCounts[i - 1].count : item.count;
    const dropOff = prevCount > 0 ? (1 - item.count / prevCount) * 100 : 0;
    return {
      step: item.step,
      count: item.count,
      dropOffPercent: i > 0 ? Math.round(dropOff * 10) / 10 : 0,
    };
  });

  const ctaClickEvents = await prisma.marketingEvent.findMany({
    where: { ...where, eventName: 'marketing.cta_click', ctaId: { not: null } },
    select: { ctaId: true, sessionId: true, properties: true },
  });

  const ctaMap = new Map();
  for (const ev of ctaClickEvents) {
    if (!ev.ctaId) continue;
    const cur = ctaMap.get(ev.ctaId) || { clicks: 0, sessions: new Set() };
    cur.clicks += 1;
    cur.sessions.add(ev.sessionId);
    ctaMap.set(ev.ctaId, cur);
  }

  const labelByCta = new Map();
  for (const ev of ctaClickEvents) {
    if (!ev.ctaId || labelByCta.has(ev.ctaId)) continue;
    const p = ev.properties;
    if (p && typeof p === 'object' && p.label) {
      labelByCta.set(ev.ctaId, String(p.label));
    }
  }

  const topCtas = [...ctaMap.entries()]
    .map(([ctaId, data]) => ({
      ctaId,
      label: labelByCta.get(ctaId) ?? null,
      clicks: data.clicks,
      uniqueSessions: data.sessions.size,
    }))
    .sort((a, b) => b.uniqueSessions - a.uniqueSessions)
    .slice(0, 30);

  const pageViewEvents = await prisma.marketingEvent.findMany({
    where: { ...where, eventName: 'marketing.page_view' },
    select: { sessionId: true, pagePath: true, deviceType: true, timestamp: true },
  });

  const deviceSessionMap = new Map();
  const pageSessionMap = new Map();
  for (const ev of pageViewEvents) {
    const device = ev.deviceType || 'unknown';
    if (!deviceSessionMap.has(device)) deviceSessionMap.set(device, new Set());
    deviceSessionMap.get(device).add(ev.sessionId);

    if (!pageSessionMap.has(ev.pagePath)) pageSessionMap.set(ev.pagePath, new Set());
    pageSessionMap.get(ev.pagePath).add(ev.sessionId);
  }

  const deviceCounts = [...deviceSessionMap.entries()].map(([device, sessions]) => ({
    device,
    sessions: sessions.size,
  }));

  const byPage = [...pageSessionMap.entries()]
    .map(([pagePath, sessions]) => ({ pagePath, sessions: sessions.size }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 25);

  const ctaEvents = await prisma.marketingEvent.findMany({
    where: { ...where, eventName: 'marketing.cta_click' },
    select: { sessionId: true, timestamp: true },
  });

  const dailyMap = new Map();

  for (const ev of pageViewEvents) {
    const day = ev.timestamp.toISOString().slice(0, 10);
    const cur = dailyMap.get(day) || { date: day, pageViewSessions: new Set(), ctaClickSessions: new Set() };
    cur.pageViewSessions = cur.pageViewSessions || new Set();
    cur.pageViewSessions.add(ev.sessionId);
    dailyMap.set(day, cur);
  }

  for (const ev of ctaEvents) {
    const day = ev.timestamp.toISOString().slice(0, 10);
    const cur = dailyMap.get(day) || { date: day, pageViewSessions: new Set(), ctaClickSessions: new Set() };
    cur.ctaClickSessions = cur.ctaClickSessions || new Set();
    cur.ctaClickSessions.add(ev.sessionId);
    dailyMap.set(day, cur);
  }

  const dailySeries = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      pageViews: data.pageViewSessions?.size ?? 0,
      ctaClicks: data.ctaClickSessions?.size ?? 0,
    }));

  const pagePaths = await prisma.marketingEvent.findMany({
    where: { timestamp: { gte: from, lte: to }, eventName: 'marketing.page_view' },
    select: { pagePath: true },
    distinct: ['pagePath'],
    orderBy: { pagePath: 'asc' },
  });

  return {
    dateRange: { from: from.toISOString(), to: to.toISOString() },
    pagePath: pagePathFilter || null,
    funnel,
    funnelCompletionRate: pageViews > 0 ? Math.round((registerCta / pageViews) * 1000) / 10 : 0,
    topCtas,
    byPage,
    byDevice: deviceCounts,
    dailySeries,
    pagePaths: pagePaths.map((p) => p.pagePath),
  };
}

module.exports = { getMarketingAnalytics };
