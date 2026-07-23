'use strict';

const { DateTime } = require('luxon');
const { RULE_DEFAULTS, CRITICAL_RULE_IDS, ruleVersionString } = require('./config');

function notTriggered() {
  return { triggered: false };
}

function triggered(partial) {
  return { triggered: true, ...partial };
}

function expiresInDays(now, days) {
  return DateTime.fromJSDate(now instanceof Date ? now : new Date(now))
    .plus({ days })
    .toJSDate();
}

function dayNameEs(jsDow) {
  const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return names[jsDow] || 'día';
}

function formatYmdEs(ymd) {
  // yyyy-MM-dd → "14 de julio"
  const dt = DateTime.fromISO(ymd);
  if (!dt.isValid) return ymd;
  return dt.setLocale('es-CL').toFormat("d 'de' LLLL");
}

function ruleMeta(ruleId) {
  return RULE_DEFAULTS[ruleId];
}

function stageAllowed(ruleId, stage) {
  return (RULE_DEFAULTS[ruleId]?.stages || []).includes(stage);
}

/** Criticas */
function evalSinHorarios(ctx) {
  const id = 'sin_horarios_activos';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  if (ctx.hasActiveSchedule) return notTriggered();
  const meta = ruleMeta(id);
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: null,
    payload: {
      metric: 'config_schedule',
      activeScheduleDayCount: ctx.activeScheduleDayCount,
      debug: { version: meta.version, reason: 'no_active_schedule_days' },
    },
  });
}

function evalSinMesas(ctx) {
  const id = 'sin_mesas_activas';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  if (ctx.activeTableCount > 0) return notTriggered();
  const meta = ruleMeta(id);
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: null,
    payload: {
      metric: 'config_tables',
      activeTableCount: 0,
      debug: { version: meta.version, reason: 'no_active_tables' },
    },
  });
}

function evalProximosSinCupos(ctx) {
  const id = 'proximos_dias_sin_cupos';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  if (!ctx.hasActiveSchedule || ctx.activeTableCount === 0) return notTriggered();
  // Don't treat a failed availability load as "zero slots"
  if (ctx.availabilityLoadFailed) return notTriggered();
  if (ctx.totalFutureSlots > 0) return notTriggered();

  const meta = ruleMeta(id);
  const allBlocked =
    ctx.fullyBlockedFutureDays >= ctx.futureAvailability.length &&
    ctx.futureAvailability.length > 0;
  const cause = allBlocked ? 'blocked' : 'config_or_policies';
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: expiresInDays(ctx.now, 3),
    payload: {
      metric: 'future_availability',
      totalFutureSlots: 0,
      futureDays: ctx.futureAvailability.length,
      fullyBlockedFutureDays: ctx.fullyBlockedFutureDays,
      partySizesEvaluated: ctx.partySizesToEval,
      cause,
      debug: { version: meta.version, cause },
    },
  });
}

function evalSinReservasOnline(ctx) {
  const id = 'sin_reservas_online_recientes';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);
  if (ctx.recentOpenDaysWithCapacity < meta.minOpenDaysWithSlots) return notTriggered();
  if (ctx.receivedOnlineLast7 > 0) return notTriggered();
  if (ctx.totalOnlineEver < 1 && ctx.maturityStage === 'aprendizaje') {
    // aprendizaje already implies history; keep
  }
  if (ctx.totalOnlineEver < 1) return notTriggered();

  let variant = 'generic';
  if (ctx.funnel.hasAnyEvents) {
    if (ctx.funnel.pageViewSessions < meta.lowTrafficSessions) {
      variant = 'sin_trafico';
    } else if (
      ctx.funnel.noSlotsShown > 0 &&
      ctx.funnel.noSlotsShown >= ctx.funnel.pageViewSessions * 0.4
    ) {
      variant = 'sin_cupos_visibles';
    } else if (ctx.funnel.confirmed === 0 && ctx.funnel.pageViewSessions >= meta.lowTrafficSessions) {
      variant = 'abandono';
    } else {
      variant = 'sin_trafico';
    }
  }

  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: `last7:${ctx.todayYmd}`,
    expiresAt: expiresInDays(ctx.now, 7),
    payload: {
      metric: 'recibidas_online',
      receivedOnlineLast7: 0,
      receivedManualLast7: ctx.receivedManualLast7,
      recentOpenDaysWithCapacity: ctx.recentOpenDaysWithCapacity,
      variant,
      funnel: {
        pageViewSessions: ctx.funnel.pageViewSessions,
        noSlotsShown: ctx.funnel.noSlotsShown,
        confirmed: ctx.funnel.confirmed,
        hasAnyEvents: ctx.funnel.hasAnyEvents,
      },
      publicBookingUrl: ctx.publicBookingUrl,
      debug: {
        version: meta.version,
        variant,
        thresholdOpenDays: meta.minOpenDaysWithSlots,
      },
    },
  });
}

function evalCaida(ctx) {
  const id = 'caida_de_reservas';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);
  const last = ctx.lastCompleteWeek;
  if (!last || !last.comparable) return notTriggered();

  const baseline = ctx.comparableWeeks
    .slice(1, meta.maxComparableWeeks + 1)
    .filter((w) => w.comparable)
    .slice(0, meta.maxComparableWeeks);

  if (baseline.length < meta.minComparableWeeks) return notTriggered();

  const avgPerOpen =
    baseline.reduce((s, w) => s + w.receivedPerOpenDay, 0) / baseline.length;
  const avgWeekly =
    baseline.reduce((s, w) => s + w.receivedTotal, 0) / baseline.length;

  if (avgWeekly < meta.minBaselineWeeklyReceived) return notTriggered();
  if (last.openDays === 0) return notTriggered();

  const drop =
    avgPerOpen > 0 ? (avgPerOpen - last.receivedPerOpenDay) / avgPerOpen : 0;
  if (drop < meta.dropThreshold) return notTriggered();

  let confidence = 'low';
  if (baseline.length >= 4) confidence = 'high';
  else if (baseline.length >= 3) confidence = 'medium';

  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence,
    dedupeKey: last.weekKey,
    expiresAt: expiresInDays(ctx.now, 14),
    periodStart: last.weekStartYmd,
    periodEnd: last.weekEndYmd,
    payload: {
      metric: 'recibidas_por_dia_apertura',
      lastWeekReceived: last.receivedTotal,
      lastWeekReceivedPerOpenDay: round2(last.receivedPerOpenDay),
      baselineAvgReceived: round2(avgWeekly),
      baselineAvgPerOpenDay: round2(avgPerOpen),
      dropRatio: round2(drop),
      comparableWeeks: baseline.length,
      lastWeekKey: last.weekKey,
      debug: {
        version: meta.version,
        dropThreshold: meta.dropThreshold,
        drop,
        baselineWeekKeys: baseline.map((w) => w.weekKey),
      },
    },
  });
}

function evalVentanaCorta(ctx) {
  const id = 'ventana_futura_corta';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);
  const days = ctx.restaurant.advanceBookingLimitDays ?? 30;
  if (days > meta.maxDays) return notTriggered();
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: expiresInDays(ctx.now, 30),
    payload: {
      metric: 'advanceBookingLimitDays',
      advanceBookingLimitDays: days,
      threshold: meta.maxDays,
      debug: { version: meta.version },
    },
  });
}

function evalAvisoMinimo(ctx) {
  const id = 'aviso_minimo_alto';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);
  const minutes = ctx.restaurant.minimumNoticeMinutes ?? 60;
  if (minutes < meta.minMinutes) return notTriggered();
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: expiresInDays(ctx.now, 30),
    payload: {
      metric: 'minimumNoticeMinutes',
      minimumNoticeMinutes: minutes,
      threshold: meta.minMinutes,
      debug: { version: meta.version },
    },
  });
}

function evalPerfilIncompleto(ctx) {
  const id = 'perfil_incompleto';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  if (!ctx.missingProfile.length) return notTriggered();
  const meta = ruleMeta(id);
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: expiresInDays(ctx.now, 30),
    payload: {
      metric: 'profile_fields',
      missing: ctx.missingProfile,
      debug: { version: meta.version, missing: ctx.missingProfile },
    },
  });
}

function evalSinDatosContacto(ctx) {
  const id = 'sin_datos_contacto';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  if (ctx.restaurant.requireEmail || ctx.restaurant.requirePhoneNumber) {
    return notTriggered();
  }
  const meta = ruleMeta(id);
  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: 'current',
    expiresAt: expiresInDays(ctx.now, 30),
    payload: {
      metric: 'contact_requirements',
      requireEmail: false,
      requirePhoneNumber: false,
      debug: { version: meta.version },
    },
  });
}

function evalDiasProximosConCupos(ctx) {
  const id = 'dias_proximos_con_cupos';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);

  const candidates = ctx.futureAvailability
    .filter((d) => d.scheduleOpen && !d.blocked && d.freeSlots >= meta.minFreeSlots)
    .sort((a, b) => b.freeSlots - a.freeSlots);

  if (!candidates.length) return notTriggered();
  // Prefer days that are not today if possible
  const pick = candidates.find((d) => d.date !== ctx.todayYmd) || candidates[0];

  const dayLabel = dayNameEs(pick.dayOfWeek);
  const dateLabel = formatYmdEs(pick.date);
  const promoText = `¡Quedan horarios disponibles el ${dayLabel} ${dateLabel} en ${ctx.restaurant.name}! Reserva aquí: ${ctx.publicBookingUrl}`;

  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence: meta.confidence,
    dedupeKey: pick.date,
    expiresAt: DateTime.fromISO(pick.date, { zone: ctx.timezone }).endOf('day').toJSDate(),
    payload: {
      metric: 'future_free_slots',
      date: pick.date,
      dayOfWeek: pick.dayOfWeek,
      dayLabel,
      dateLabel,
      freeSlots: pick.freeSlots,
      publicBookingUrl: ctx.publicBookingUrl,
      promoText,
      debug: {
        version: meta.version,
        minFreeSlots: meta.minFreeSlots,
        freeSlots: pick.freeSlots,
      },
    },
  });
}

function evalTendenciaPositiva(ctx) {
  const id = 'tendencia_positiva';
  if (!stageAllowed(id, ctx.maturityStage)) return notTriggered();
  const meta = ruleMeta(id);
  const last = ctx.lastCompleteWeek;
  if (!last || !last.comparable) return notTriggered();
  if (last.receivedTotal < meta.minWeeklyReceived) return notTriggered();

  const baseline = ctx.comparableWeeks
    .slice(1, meta.maxComparableWeeks + 1)
    .filter((w) => w.comparable)
    .slice(0, meta.maxComparableWeeks);
  if (baseline.length < meta.minComparableWeeks) return notTriggered();

  const avgPerOpen =
    baseline.reduce((s, w) => s + w.receivedPerOpenDay, 0) / baseline.length;
  if (avgPerOpen <= 0) return notTriggered();

  const growth = (last.receivedPerOpenDay - avgPerOpen) / avgPerOpen;
  if (growth < meta.growthThreshold) return notTriggered();

  // Top programmed day in last week
  let topDay = null;
  for (const d of last.days) {
    if (!topDay || d.programmed > topDay.programmed) topDay = d;
  }

  let confidence = 'low';
  if (baseline.length >= 4) confidence = 'high';
  else if (baseline.length >= 3) confidence = 'medium';

  return triggered({
    ruleId: id,
    ruleVersion: ruleVersionString(id),
    category: meta.category,
    priority: meta.priority,
    confidence,
    dedupeKey: last.weekKey,
    expiresAt: expiresInDays(ctx.now, 14),
    periodStart: last.weekStartYmd,
    periodEnd: last.weekEndYmd,
    payload: {
      metric: 'recibidas_por_dia_apertura',
      lastWeekReceived: last.receivedTotal,
      lastWeekReceivedPerOpenDay: round2(last.receivedPerOpenDay),
      baselineAvgPerOpenDay: round2(avgPerOpen),
      growthRatio: round2(growth),
      comparableWeeks: baseline.length,
      topDay: topDay
        ? {
            date: topDay.ymd,
            programmed: topDay.programmed,
            dayLabel: dayNameEs(
              DateTime.fromISO(topDay.ymd, { zone: ctx.timezone }).weekday % 7,
            ),
          }
        : null,
      debug: {
        version: meta.version,
        growthThreshold: meta.growthThreshold,
        growth,
      },
    },
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const RULE_EVALUATORS = [
  evalSinHorarios,
  evalSinMesas,
  evalProximosSinCupos,
  evalSinReservasOnline,
  evalCaida,
  evalVentanaCorta,
  evalAvisoMinimo,
  evalPerfilIncompleto,
  evalSinDatosContacto,
  evalDiasProximosConCupos,
  evalTendenciaPositiva,
];

/**
 * Evalúa todas las reglas y aplica la matriz de exclusión.
 * @returns {{ results: object[], suppressedRuleIds: string[], activeCriticalIds: string[] }}
 */
function evaluateAllRules(ctx) {
  const raw = [];
  for (const fn of RULE_EVALUATORS) {
    const result = fn(ctx);
    if (result?.triggered) raw.push(result);
  }

  const activeCriticalIds = raw
    .filter((r) => CRITICAL_RULE_IDS.includes(r.ruleId))
    .map((r) => r.ruleId);

  const suppressedRuleIds = [];
  const results = [];

  for (const r of raw) {
    const suppressedBy = RULE_DEFAULTS[r.ruleId]?.suppressedBy || [];
    const hit = suppressedBy.filter((id) => activeCriticalIds.includes(id));
    if (hit.length) {
      suppressedRuleIds.push(r.ruleId);
      continue;
    }
    results.push(r);
  }

  return { results, suppressedRuleIds, activeCriticalIds };
}

module.exports = {
  evaluateAllRules,
  RULE_EVALUATORS,
  evalSinHorarios,
  evalSinMesas,
  evalProximosSinCupos,
  evalSinReservasOnline,
  evalCaida,
  evalVentanaCorta,
  evalAvisoMinimo,
  evalPerfilIncompleto,
  evalSinDatosContacto,
  evalDiasProximosConCupos,
  evalTendenciaPositiva,
  dayNameEs,
  CRITICAL_RULE_IDS,
};
