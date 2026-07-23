'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAllRules } = require('./rules');
const { computeMaturityStage } = require('./context');
const { payloadHasPii } = require('./index');
const { buildWeeklySummary } = require('./weeklySummary');
const { renderRecommendation, buildChecklistPresentation } = require('./catalog');
const { STAGES, CRITICAL_RULE_IDS } = require('./config');

function baseCtx(overrides = {}) {
  const today = '2026-07-14';
  return {
    restaurantId: 'rest_1',
    restaurant: {
      id: 'rest_1',
      name: 'Café Demo',
      slug: 'cafe-demo',
      dataVersion: 1,
      onboardingCompletedAt: new Date('2026-01-01'),
      advanceBookingLimitDays: 30,
      minimumNoticeMinutes: 60,
      requireEmail: true,
      requirePhoneNumber: false,
      scheduleMode: 'continuous',
      timezone: 'America/Santiago',
    },
    publicBookingUrl: 'https://simplereserva.com/restaurant/cafe-demo',
    now: new Date('2026-07-14T15:00:00.000Z'),
    todayYmd: today,
    timezone: 'America/Santiago',
    hasActiveSchedule: true,
    activeTableCount: 5,
    activeScheduleDayCount: 6,
    missingProfile: [],
    checklist: {
      profileComplete: true,
      hasSchedule: true,
      hasTables: true,
      hasPublicPage: true,
      hasOnlineReservation: true,
      onboardingComplete: true,
    },
    partySizesToEval: [2],
    medianPartySize: 2,
    futureAvailability: [
      { date: '2026-07-14', dayOfWeek: 2, scheduleOpen: true, blocked: false, freeSlots: 8 },
      { date: '2026-07-15', dayOfWeek: 3, scheduleOpen: true, blocked: false, freeSlots: 6 },
      { date: '2026-07-16', dayOfWeek: 4, scheduleOpen: true, blocked: false, freeSlots: 10 },
      { date: '2026-07-17', dayOfWeek: 5, scheduleOpen: true, blocked: false, freeSlots: 12 },
      { date: '2026-07-18', dayOfWeek: 6, scheduleOpen: true, blocked: false, freeSlots: 4 },
      { date: '2026-07-19', dayOfWeek: 0, scheduleOpen: false, blocked: false, freeSlots: 0 },
      { date: '2026-07-20', dayOfWeek: 1, scheduleOpen: true, blocked: false, freeSlots: 5 },
    ],
    totalFutureSlots: 45,
    openDaysWithSlots: 6,
    fullyBlockedFutureDays: 0,
    recentOpenDaysWithCapacity: 5,
    receivedOnlineLast7: 3,
    receivedManualLast7: 1,
    totalOnlineEver: 40,
    funnel: {
      hasAnyEvents: true,
      pageViewSessions: 20,
      noSlotsShown: 2,
      confirmed: 5,
      days: 14,
    },
    weeks: [],
    comparableWeeks: [],
    lastCompleteWeek: null,
    fingerprint: 'abc',
    configStableSince: new Date('2026-01-01'),
    maturityStage: STAGES.INSIGHTS,
    metrics: {
      receivedOnlineHistory: 40,
      receivedManualHistory: 10,
      cancelledInHistory: 2,
    },
    ...overrides,
  };
}

function makeWeek(key, opts = {}) {
  return {
    weekKey: key,
    weekStartYmd: opts.weekStartYmd || '2026-07-06',
    weekEndYmd: opts.weekEndYmd || '2026-07-12',
    openDays: opts.openDays ?? 5,
    programmed: opts.programmed ?? 10,
    covers: opts.covers ?? 25,
    cancelled: opts.cancelled ?? 1,
    receivedOnline: opts.receivedOnline ?? 8,
    receivedManual: opts.receivedManual ?? 2,
    receivedTotal: opts.receivedTotal ?? 10,
    receivedPerOpenDay: opts.receivedPerOpenDay ?? 2,
    programmedPerOpenDay: opts.programmedPerOpenDay ?? 2,
    hourBuckets: new Map([['5|20', 4]]),
    days: opts.days || [
      { ymd: '2026-07-06', open: true, programmed: 1 },
      { ymd: '2026-07-07', open: true, programmed: 2 },
      { ymd: '2026-07-08', open: true, programmed: 1 },
      { ymd: '2026-07-09', open: true, programmed: 3 },
      { ymd: '2026-07-10', open: true, programmed: 5 },
      { ymd: '2026-07-11', open: true, programmed: 2 },
      { ymd: '2026-07-12', open: false, programmed: 0 },
    ],
    comparable: opts.comparable !== false,
  };
}

describe('computeMaturityStage', () => {
  it('configuracion sin horarios o mesas', () => {
    assert.equal(
      computeMaturityStage({
        onboardingCompletedAt: new Date(),
        hasActiveSchedule: false,
        activeTableCount: 5,
        daysSinceOnboarding: 30,
        totalOnlineReceived: 50,
        comparableWeeksCount: 5,
        receivedInHistoryWeeks: 50,
      }),
      STAGES.CONFIGURACION,
    );
  });

  it('activacion con pocos datos', () => {
    assert.equal(
      computeMaturityStage({
        onboardingCompletedAt: new Date(),
        hasActiveSchedule: true,
        activeTableCount: 3,
        daysSinceOnboarding: 5,
        totalOnlineReceived: 2,
        comparableWeeksCount: 0,
        receivedInHistoryWeeks: 2,
      }),
      STAGES.ACTIVACION,
    );
  });

  it('insights con volumen y semanas', () => {
    assert.equal(
      computeMaturityStage({
        onboardingCompletedAt: new Date(),
        hasActiveSchedule: true,
        activeTableCount: 5,
        daysSinceOnboarding: 60,
        totalOnlineReceived: 40,
        comparableWeeksCount: 5,
        receivedInHistoryWeeks: 40,
      }),
      STAGES.INSIGHTS,
    );
  });
});

describe('escenario restaurante nuevo / configuracion', () => {
  it('no dispara reglas estadísticas; críticas de config sí en activacion', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.CONFIGURACION,
      hasActiveSchedule: false,
      activeTableCount: 0,
      totalOnlineEver: 0,
      receivedOnlineLast7: 0,
    });
    const { results } = evaluateAllRules(ctx);
    assert.equal(results.length, 0);
  });

  it('checklist presentation tiene ítems', () => {
    const checklist = buildChecklistPresentation(
      {
        profileComplete: false,
        hasSchedule: false,
        hasTables: false,
        hasPublicPage: true,
        hasOnlineReservation: false,
        onboardingComplete: false,
      },
      'https://simplereserva.com/restaurant/x',
    );
    assert.ok(checklist.items.length >= 5);
    assert.ok(checklist.message.includes('más reservas'));
  });
});

describe('escenario sin disponibilidad', () => {
  it('dispara proximos_dias_sin_cupos y suprime promoción', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.APRENDIZAJE,
      totalFutureSlots: 0,
      openDaysWithSlots: 0,
      fullyBlockedFutureDays: 7,
      futureAvailability: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-07-${14 + i}`,
        dayOfWeek: i,
        scheduleOpen: true,
        blocked: true,
        freeSlots: 0,
      })),
      receivedOnlineLast7: 0,
      recentOpenDaysWithCapacity: 5,
      totalOnlineEver: 20,
    });
    const { results, suppressedRuleIds, activeCriticalIds } = evaluateAllRules(ctx);
    assert.ok(activeCriticalIds.includes('proximos_dias_sin_cupos'));
    assert.ok(results.some((r) => r.ruleId === 'proximos_dias_sin_cupos'));
    assert.ok(suppressedRuleIds.includes('sin_reservas_online_recientes'));
    assert.ok(!results.some((r) => r.ruleId === 'sin_reservas_online_recientes'));
    assert.ok(!results.some((r) => r.ruleId === 'dias_proximos_con_cupos'));
  });

  it('no dispara proximos_dias_sin_cupos si falló la carga de availability', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.APRENDIZAJE,
      totalFutureSlots: 0,
      availabilityLoadFailed: true,
      openDaysWithSlots: 0,
      futureAvailability: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-07-${14 + i}`,
        dayOfWeek: i,
        scheduleOpen: true,
        blocked: false,
        freeSlots: 0,
      })),
    });
    const { results, activeCriticalIds } = evaluateAllRules(ctx);
    assert.ok(!activeCriticalIds.includes('proximos_dias_sin_cupos'));
    assert.ok(!results.some((r) => r.ruleId === 'proximos_dias_sin_cupos'));
  });
});

describe('escenario sin reservas online', () => {
  it('variante sin_trafico', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.APRENDIZAJE,
      receivedOnlineLast7: 0,
      recentOpenDaysWithCapacity: 4,
      totalOnlineEver: 15,
      funnel: {
        hasAnyEvents: true,
        pageViewSessions: 2,
        noSlotsShown: 0,
        confirmed: 0,
        days: 14,
      },
    });
    const { results } = evaluateAllRules(ctx);
    const hit = results.find((r) => r.ruleId === 'sin_reservas_online_recientes');
    assert.ok(hit);
    assert.equal(hit.payload.variant, 'sin_trafico');
  });

  it('variante sin_cupos_visibles', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.APRENDIZAJE,
      receivedOnlineLast7: 0,
      recentOpenDaysWithCapacity: 4,
      totalOnlineEver: 15,
      funnel: {
        hasAnyEvents: true,
        pageViewSessions: 10,
        noSlotsShown: 8,
        confirmed: 0,
        days: 14,
      },
    });
    const { results } = evaluateAllRules(ctx);
    const hit = results.find((r) => r.ruleId === 'sin_reservas_online_recientes');
    assert.ok(hit);
    assert.equal(hit.payload.variant, 'sin_cupos_visibles');
  });
});

describe('escenario activo / alto volumen', () => {
  it('caida_de_reservas con semanas comparables', () => {
    const last = makeWeek('2026-W28', {
      receivedTotal: 3,
      receivedPerOpenDay: 0.6,
      openDays: 5,
    });
    const baseline = [
      makeWeek('2026-W27', { receivedTotal: 12, receivedPerOpenDay: 2.4 }),
      makeWeek('2026-W26', { receivedTotal: 11, receivedPerOpenDay: 2.2 }),
      makeWeek('2026-W25', { receivedTotal: 10, receivedPerOpenDay: 2.0 }),
    ];
    const ctx = baseCtx({
      maturityStage: STAGES.INSIGHTS,
      lastCompleteWeek: last,
      comparableWeeks: [last, ...baseline],
      weeks: [last, ...baseline],
    });
    const { results } = evaluateAllRules(ctx);
    assert.ok(results.some((r) => r.ruleId === 'caida_de_reservas'));
  });

  it('tendencia_positiva', () => {
    const last = makeWeek('2026-W28', {
      receivedTotal: 20,
      receivedPerOpenDay: 4,
      openDays: 5,
    });
    const baseline = [
      makeWeek('2026-W27', { receivedTotal: 10, receivedPerOpenDay: 2 }),
      makeWeek('2026-W26', { receivedTotal: 10, receivedPerOpenDay: 2 }),
    ];
    const ctx = baseCtx({
      maturityStage: STAGES.INSIGHTS,
      lastCompleteWeek: last,
      comparableWeeks: [last, ...baseline],
    });
    const { results } = evaluateAllRules(ctx);
    assert.ok(results.some((r) => r.ruleId === 'tendencia_positiva'));
  });

  it('dias_proximos_con_cupos', () => {
    const ctx = baseCtx({ maturityStage: STAGES.APRENDIZAJE });
    const { results } = evaluateAllRules(ctx);
    const hit = results.find((r) => r.ruleId === 'dias_proximos_con_cupos');
    assert.ok(hit);
    assert.ok(hit.payload.promoText.includes('Café Demo'));
    assert.ok(hit.payload.publicBookingUrl);
  });
});

describe('reglas de configuración', () => {
  it('ventana_futura_corta y aviso_minimo_alto y perfil y contacto', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.ACTIVACION,
      restaurant: {
        ...baseCtx().restaurant,
        advanceBookingLimitDays: 5,
        minimumNoticeMinutes: 2880,
        requireEmail: false,
        requirePhoneNumber: false,
      },
      missingProfile: ['logo', 'descripcion'],
    });
    const { results } = evaluateAllRules(ctx);
    const ids = results.map((r) => r.ruleId);
    assert.ok(ids.includes('ventana_futura_corta'));
    assert.ok(ids.includes('aviso_minimo_alto'));
    assert.ok(ids.includes('perfil_incompleto'));
    assert.ok(ids.includes('sin_datos_contacto'));
  });
});

describe('matriz de exclusión', () => {
  it('críticas suprimen promoción', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.INSIGHTS,
      hasActiveSchedule: false,
      receivedOnlineLast7: 0,
      recentOpenDaysWithCapacity: 5,
      totalOnlineEver: 20,
    });
    // sin_horarios only triggers in activacion+ but hasActiveSchedule false
    // Wait - sin_horarios needs !hasActiveSchedule which we have
    const { results, suppressedRuleIds, activeCriticalIds } = evaluateAllRules(ctx);
    assert.ok(activeCriticalIds.includes('sin_horarios_activos'));
    assert.ok(CRITICAL_RULE_IDS.includes('sin_horarios_activos'));
    assert.ok(suppressedRuleIds.includes('sin_reservas_online_recientes'));
    assert.ok(!results.some((r) => r.ruleId === 'sin_reservas_online_recientes'));
  });
});

describe('comparabilidad de semanas', () => {
  it('omite caida si no hay semanas comparables suficientes', () => {
    const last = makeWeek('2026-W28', {
      receivedTotal: 2,
      receivedPerOpenDay: 0.4,
    });
    const ctx = baseCtx({
      maturityStage: STAGES.INSIGHTS,
      lastCompleteWeek: last,
      comparableWeeks: [last], // solo 1
    });
    const { results } = evaluateAllRules(ctx);
    assert.ok(!results.some((r) => r.ruleId === 'caida_de_reservas'));
  });

  it('omite semana sin días abiertos', () => {
    const last = makeWeek('2026-W28', {
      openDays: 0,
      comparable: false,
      receivedTotal: 0,
      receivedPerOpenDay: 0,
    });
    const baseline = [
      makeWeek('2026-W27', { receivedTotal: 12, receivedPerOpenDay: 2.4 }),
      makeWeek('2026-W26', { receivedTotal: 11, receivedPerOpenDay: 2.2 }),
    ];
    const ctx = baseCtx({
      maturityStage: STAGES.INSIGHTS,
      lastCompleteWeek: last,
      comparableWeeks: baseline, // last not comparable
    });
    const { results } = evaluateAllRules(ctx);
    assert.ok(!results.some((r) => r.ruleId === 'caida_de_reservas'));
  });
});

describe('PII en payloads', () => {
  it('payloads de reglas no contienen PII', () => {
    const ctx = baseCtx({
      maturityStage: STAGES.ACTIVACION,
      hasActiveSchedule: false,
      activeTableCount: 0,
      missingProfile: ['logo'],
      restaurant: {
        ...baseCtx().restaurant,
        advanceBookingLimitDays: 3,
        minimumNoticeMinutes: 2000,
        requireEmail: false,
        requirePhoneNumber: false,
      },
      receivedOnlineLast7: 0,
      recentOpenDaysWithCapacity: 3,
      totalOnlineEver: 10,
      totalFutureSlots: 0,
    });
    // Force activacion so config rules fire; for sin_horarios
    const { results } = evaluateAllRules({
      ...ctx,
      maturityStage: STAGES.ACTIVACION,
      hasActiveSchedule: true,
      activeTableCount: 2,
      totalFutureSlots: 10,
    });
    for (const r of results) {
      assert.equal(payloadHasPii(r.payload), false, `PII in ${r.ruleId}`);
      assert.equal(JSON.stringify(r.payload).includes('customerName'), false);
      assert.equal(JSON.stringify(r.payload).includes('customerEmail'), false);
      assert.equal(JSON.stringify(r.payload).includes('customerPhone'), false);
    }
  });
});

describe('catalog y weekly summary', () => {
  it('renderiza textos sin ambigüedad de "reservas" sueltas en caida', () => {
    const rendered = renderRecommendation({
      ruleId: 'caida_de_reservas',
      confidence: 'high',
      payload: {
        lastWeekReceived: 3,
        lastWeekReceivedPerOpenDay: 0.6,
        baselineAvgReceived: 10,
        baselineAvgPerOpenDay: 2,
        dropRatio: 0.7,
        comparableWeeks: 3,
      },
    });
    assert.ok(rendered.title.includes('recibidas') || rendered.explanation.includes('recibidas'));
    assert.ok(rendered.ctas.length > 0);
  });

  it('weekly summary disponible', () => {
    const last = makeWeek('2026-W28');
    const summary = buildWeeklySummary(
      baseCtx({
        lastCompleteWeek: last,
        comparableWeeks: [last, makeWeek('2026-W27'), makeWeek('2026-W26')],
      }),
    );
    assert.equal(summary.available, true);
    assert.equal(summary.receivedTotal, 10);
    assert.ok(summary.topDay);
  });
});
