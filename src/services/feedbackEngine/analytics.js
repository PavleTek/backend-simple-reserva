'use strict';

const prisma = require('../../lib/prisma');
const { computeSatisfactionIndex, computeFunnelRates } = require('./satisfactionIndex');

/**
 * KPIs para dashboard del restaurante.
 * @param {string} restaurantId
 * @param {Date} from
 * @param {Date} to
 */
async function getRestaurantSummary(restaurantId, from, to) {
  const sentStatuses = ['sent', 'clicked', 'opened', 'completed'];

  const [sent, clicked, completed, responses, openAlerts] = await Promise.all([
    prisma.feedbackRequest.count({
      where: {
        restaurantId,
        sentAt: { gte: from, lte: to },
        status: { in: sentStatuses },
      },
    }),
    prisma.feedbackRequest.count({
      where: {
        restaurantId,
        sentAt: { gte: from, lte: to },
        clickedAt: { not: null },
      },
    }),
    prisma.feedbackRequest.count({
      where: {
        restaurantId,
        completedAt: { gte: from, lte: to },
        status: 'completed',
      },
    }),
    prisma.feedbackResponse.findMany({
      where: {
        feedbackRequest: { restaurantId },
        respondedAt: { gte: from, lte: to },
      },
      select: { overallScore: true },
    }),
    prisma.feedbackAlert.count({
      where: { restaurantId, status: 'open', type: 'recovery' },
    }),
  ]);

  const scores = responses.map((r) => r.overallScore);
  const satisfaction = computeSatisfactionIndex(scores);
  const funnel = computeFunnelRates(sent, clicked, completed);

  const resolvedRecovery = await prisma.feedbackAlert.count({
    where: {
      restaurantId,
      type: 'recovery',
      status: 'resolved',
      resolvedAt: { gte: from, lte: to },
    },
  });
  const totalRecovery = await prisma.feedbackAlert.count({
    where: {
      restaurantId,
      type: 'recovery',
      createdAt: { gte: from, lte: to },
    },
  });

  const neutralPct =
    satisfaction.count > 0
      ? Math.round((100 - satisfaction.promotersPct - satisfaction.detractorsPct) * 10) / 10
      : 0;

  return {
    period: { from, to },
    experienceAverage: satisfaction.average,
    satisfactionIndex: satisfaction.index,
    satisfactionCount: satisfaction.count,
    satisfactionPromotersPct: satisfaction.promotersPct,
    satisfactionDetractorsPct: satisfaction.detractorsPct,
    satisfactionNeutralPct: neutralPct,
    clickRate: funnel.clickRate,
    responseRate: funnel.responseRate,
    completionAfterClick: funnel.completionAfterClick,
    sent,
    clicked,
    completed,
    openRecoveryAlerts: openAlerts,
    recoveryResolvedRate:
      totalRecovery > 0 ? Math.round((resolvedRecovery / totalRecovery) * 1000) / 10 : null,
  };
}

/**
 * Agregados internos para benchmarking futuro — NO exponer a restaurant-front v1.
 * @param {object} filters
 */
async function getBenchmarkAggregates(filters = {}) {
  const { organizationId, cityKey, dayOfWeek, hourBucket, from, to } = filters;
  const where = {
    respondedAt: {},
  };
  if (from) where.respondedAt.gte = from;
  if (to) where.respondedAt.lte = to;
  if (organizationId) where.organizationId = organizationId;
  if (cityKey) where.cityKey = cityKey;
  if (dayOfWeek != null) where.dayOfWeek = dayOfWeek;
  if (hourBucket != null) where.hourBucket = hourBucket;

  const responses = await prisma.feedbackResponse.findMany({
    where,
    select: {
      overallScore: true,
      feedbackRequest: { select: { restaurantId: true } },
    },
  });

  const byRestaurant = new Map();
  for (const r of responses) {
    const rid = r.feedbackRequest?.restaurantId || 'unknown';
    if (!byRestaurant.has(rid)) byRestaurant.set(rid, []);
    byRestaurant.get(rid).push(r.overallScore);
  }

  const restaurantAvgs = [...byRestaurant.entries()].map(([id, scores]) => ({
    restaurantId: id,
    ...computeSatisfactionIndex(scores),
  }));

  const allScores = responses.map((r) => r.overallScore);
  return {
    aggregate: computeSatisfactionIndex(allScores),
    byRestaurant: restaurantAvgs,
    sampleSize: responses.length,
  };
}

/**
 * Insights heurísticos v1 por franja / zona.
 */
async function getRestaurantInsights(restaurantId, from, to) {
  const responses = await prisma.feedbackResponse.findMany({
    where: {
      feedbackRequest: { restaurantId },
      respondedAt: { gte: from, lte: to },
    },
    select: {
      overallScore: true,
      hourBucket: true,
      dayOfWeek: true,
      zoneId: true,
      reservationScore: true,
    },
  });

  if (responses.length < 3) return [];

  const insights = [];
  const byHour = groupAvg(responses, (r) => String(r.hourBucket ?? 'unknown'));
  const lowHours = Object.entries(byHour).filter(([, v]) => v.avg <= 3 && v.count >= 2);
  for (const [hour, v] of lowHours) {
    insights.push({
      type: 'hour_bucket',
      message: `La satisfacción baja alrededor de las ${hour}:00 (promedio ${v.avg.toFixed(1)}, ${v.count} respuestas).`,
      severity: 'medium',
    });
  }

  const byDow = groupAvg(responses, (r) => String(r.dayOfWeek ?? 'unknown'));
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  for (const [dow, v] of Object.entries(byDow)) {
    if (v.avg <= 3 && v.count >= 2) {
      insights.push({
        type: 'day_of_week',
        message: `Los ${dayNames[Number(dow)] || 'días'} muestran satisfacción baja (promedio ${v.avg.toFixed(1)}).`,
        severity: 'low',
      });
    }
  }

  const resScores = responses.filter((r) => r.reservationScore != null);
  if (resScores.length >= 3) {
    const avgRes =
      resScores.reduce((a, r) => a + r.reservationScore, 0) / resScores.length;
    if (avgRes <= 3) {
      insights.push({
        type: 'reservation_experience',
        message: `La experiencia de reserva puntúa bajo (${avgRes.toFixed(1)}/5 en promedio).`,
        severity: 'medium',
      });
    }
  }

  return insights.slice(0, 5);
}

function groupAvg(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const k = keyFn(item);
    if (!groups[k]) groups[k] = { sum: 0, count: 0 };
    groups[k].sum += item.overallScore;
    groups[k].count += 1;
  }
  const result = {};
  for (const [k, v] of Object.entries(groups)) {
    result[k] = { avg: v.sum / v.count, count: v.count };
  }
  return result;
}

module.exports = {
  getRestaurantSummary,
  getBenchmarkAggregates,
  getRestaurantInsights,
};
