'use strict';

const { DateTime } = require('luxon');
const { dayNameEs } = require('./rules');

/**
 * Construye el resumen semanal a partir del contexto (sin PII).
 * Persistido en InsightsState.weeklySummary.
 */
function buildWeeklySummary(ctx) {
  const last = ctx.lastCompleteWeek;
  if (!last) {
    return {
      available: false,
      reason: 'no_complete_week',
    };
  }

  let topDay = null;
  for (const d of last.days) {
    if (!topDay || d.programmed > topDay.programmed) topDay = d;
  }

  let topHourKey = null;
  let topHourCount = 0;
  if (last.hourBuckets) {
    for (const [key, count] of last.hourBuckets.entries()) {
      if (count > topHourCount) {
        topHourCount = count;
        topHourKey = key;
      }
    }
  }

  let topSlotLabel = null;
  if (topHourKey) {
    const [dow, hour] = topHourKey.split('|');
    topSlotLabel = `${dayNameEs(Number(dow))} ${hour}:00`;
  }

  const baseline = (ctx.comparableWeeks || []).slice(1, 5);
  let comparison = null;
  if (baseline.length >= 2 && last.openDays > 0) {
    const avgPerOpen =
      baseline.reduce((s, w) => s + w.receivedPerOpenDay, 0) / baseline.length;
    const delta =
      avgPerOpen > 0
        ? (last.receivedPerOpenDay - avgPerOpen) / avgPerOpen
        : null;
    comparison = {
      comparableWeeks: baseline.length,
      baselineAvgPerOpenDay: round2(avgPerOpen),
      lastPerOpenDay: round2(last.receivedPerOpenDay),
      deltaRatio: delta == null ? null : round2(delta),
    };
  }

  const upcomingOpen = (ctx.futureAvailability || [])
    .filter((d) => d.scheduleOpen && !d.blocked && d.freeSlots > 0)
    .sort((a, b) => b.freeSlots - a.freeSlots)
    .slice(0, 3)
    .map((d) => ({
      date: d.date,
      dayLabel: dayNameEs(d.dayOfWeek),
      freeSlots: d.freeSlots,
    }));

  return {
    available: true,
    weekKey: last.weekKey,
    periodStart: last.weekStartYmd,
    periodEnd: last.weekEndYmd,
    receivedOnline: last.receivedOnline,
    receivedManual: last.receivedManual,
    receivedTotal: last.receivedTotal,
    programmed: last.programmed,
    covers: last.covers,
    cancelled: last.cancelled,
    openDays: last.openDays,
    topDay: topDay
      ? {
          date: topDay.ymd,
          programmed: topDay.programmed,
          dayLabel: dayNameEs(
            DateTime.fromISO(topDay.ymd, { zone: ctx.timezone }).weekday % 7,
          ),
        }
      : null,
    topSlotLabel,
    comparison,
    upcomingAvailability: upcomingOpen,
    generatedAt: new Date().toISOString(),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildWeeklySummary };
