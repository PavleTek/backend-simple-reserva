'use strict';

const { DateTime } = require('luxon');
const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { buildInsightContext } = require('./context');
const { evaluateAllRules } = require('./rules');
const { renderRecommendation, buildChecklistPresentation } = require('./catalog');
const { buildWeeklySummary } = require('./weeklySummary');
const {
  PRIORITY_RANK,
  RULE_DEFAULTS,
  CONTEXT_DEFAULTS,
  STAGES,
  isInsightsVisibleForRestaurant,
  shouldEvaluateRestaurant,
  CRITICAL_RULE_IDS,
} = require('./config');

const INSIGHTS_LOCK_NAMESPACE = 42424201;

function restaurantIdToLockKey(restaurantId) {
  let hash = 5381;
  for (let i = 0; i < restaurantId.length; i++) {
    hash = (((hash << 5) + hash) + restaurantId.charCodeAt(i)) & 0x7fffffff;
  }
  return (INSIGHTS_LOCK_NAMESPACE ^ hash) & 0x7fffffff;
}

function isVisibleRecommendation(rec, now = new Date()) {
  if (rec.status !== 'active') return false;
  if (rec.dismissedAt) return false;
  if (rec.actionTakenAt) return false;
  if (rec.markedUsefulAt) return false;
  if (rec.snoozedUntil && new Date(rec.snoozedUntil) > now) return false;
  if (rec.expiresAt && new Date(rec.expiresAt) < now) return false;
  return true;
}

function sortRecommendations(recs) {
  return [...recs].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] || 0;
    const pb = PRIORITY_RANK[b.priority] || 0;
    if (pb !== pa) return pb - pa;
    const confRank = { high: 3, medium: 2, low: 1 };
    const ca = confRank[a.confidence] || 0;
    const cb = confRank[b.confidence] || 0;
    if (cb !== ca) return cb - ca;
    return new Date(b.generatedAt) - new Date(a.generatedAt);
  });
}

function presentRecommendation(rec) {
  const rendered = renderRecommendation({
    ruleId: rec.ruleId,
    confidence: rec.confidence,
    payload: rec.payload,
    publicBookingUrl: rec.payload?.publicBookingUrl,
  });
  return {
    id: rec.id,
    ruleId: rec.ruleId,
    ruleVersion: rec.ruleVersion,
    category: rec.category,
    priority: rec.priority,
    confidence: rec.confidence,
    status: rec.status,
    generatedAt: rec.generatedAt,
    expiresAt: rec.expiresAt,
    periodStart: rec.periodStart,
    periodEnd: rec.periodEnd,
    snoozedUntil: rec.snoozedUntil,
    markedUsefulAt: rec.markedUsefulAt,
    firstViewedAt: rec.firstViewedAt,
    title: rendered.title,
    explanation: rendered.explanation,
    action: rendered.action,
    whyShown: rendered.whyShown,
    ctas: rendered.ctas,
  };
}

async function isInCooldown(restaurantId, ruleId) {
  const days = RULE_DEFAULTS[ruleId]?.cooldownDays || 0;
  if (!days) return false;
  const cutoff = DateTime.now().minus({ days }).toJSDate();
  const recent = await prisma.recommendation.findFirst({
    where: {
      restaurantId,
      ruleId,
      OR: [
        { dismissedAt: { gte: cutoff } },
        { actionTakenAt: { gte: cutoff } },
      ],
    },
    select: { id: true },
  });
  return Boolean(recent);
}

/**
 * Evalúa y persiste recomendaciones para un restaurante.
 * Idempotente vía unique(restaurantId, ruleId, dedupeKey).
 */
async function evaluateRestaurant(restaurantId) {
  if (!shouldEvaluateRestaurant(restaurantId)) {
    return { skipped: true, reason: 'flag_disabled' };
  }

  const previousState = await prisma.insightsState.findUnique({
    where: { restaurantId },
  });

  const ctx = await buildInsightContext(restaurantId, { previousState });
  if (!ctx) return { skipped: true, reason: 'restaurant_not_found' };

  const { results, suppressedRuleIds, activeCriticalIds } = evaluateAllRules(ctx);
  const weeklySummary = buildWeeklySummary(ctx);
  const now = new Date();

  const triggeredKeys = new Set(results.map((r) => `${r.ruleId}::${r.dedupeKey}`));

  // Resolve previously active that are no longer triggered or suppressed
  const activeExisting = await prisma.recommendation.findMany({
    where: { restaurantId, status: 'active' },
  });

  for (const existing of activeExisting) {
    const key = `${existing.ruleId}::${existing.dedupeKey}`;
    const suppressed = suppressedRuleIds.includes(existing.ruleId);
    const stillTriggered = triggeredKeys.has(key);
    const expired = existing.expiresAt && new Date(existing.expiresAt) < now;

    if (expired) {
      await prisma.recommendation.update({
        where: { id: existing.id },
        data: { status: 'expired' },
      });
      await prisma.recommendationEvent.create({
        data: {
          restaurantId,
          recommendationId: existing.id,
          ruleId: existing.ruleId,
          eventType: 'expired',
        },
      });
      continue;
    }

    if (suppressed || !stillTriggered) {
      const payload = {
        ...(typeof existing.payload === 'object' && existing.payload ? existing.payload : {}),
        resolutionReason: suppressed ? 'suppressed' : 'condition_cleared',
        suppressedBy: suppressed ? activeCriticalIds : undefined,
      };
      await prisma.recommendation.update({
        where: { id: existing.id },
        data: { status: 'resolved', payload },
      });
      await prisma.recommendationEvent.create({
        data: {
          restaurantId,
          recommendationId: existing.id,
          ruleId: existing.ruleId,
          eventType: 'resolved',
          metadata: { reason: suppressed ? 'suppressed' : 'condition_cleared' },
        },
      });
    }
  }

  let created = 0;
  let updated = 0;

  for (const result of results) {
    if (await isInCooldown(restaurantId, result.ruleId)) continue;

    const periodStart = result.periodStart
      ? new Date(`${result.periodStart}T12:00:00.000Z`)
      : null;
    const periodEnd = result.periodEnd
      ? new Date(`${result.periodEnd}T12:00:00.000Z`)
      : null;

    const existing = await prisma.recommendation.findUnique({
      where: {
        restaurantId_ruleId_dedupeKey: {
          restaurantId,
          ruleId: result.ruleId,
          dedupeKey: result.dedupeKey,
        },
      },
    });

    if (existing) {
      // Cooldown already passed (we skipped isInCooldown above). Clear hide flags so
      // dedupeKey:'current' rules can reappear after dismiss / action_taken.
      await prisma.recommendation.update({
        where: { id: existing.id },
        data: {
          status: 'active',
          ruleVersion: result.ruleVersion,
          category: result.category,
          priority: result.priority,
          confidence: result.confidence,
          payload: result.payload,
          periodStart,
          periodEnd,
          expiresAt: result.expiresAt || null,
          generatedAt: now,
          dismissedAt: null,
          actionTakenAt: null,
          markedUsefulAt: null,
        },
      });
      updated += 1;
    } else {
      const createdRec = await prisma.recommendation.create({
        data: {
          restaurantId,
          ruleId: result.ruleId,
          ruleVersion: result.ruleVersion,
          category: result.category,
          priority: result.priority,
          confidence: result.confidence,
          status: 'active',
          dedupeKey: result.dedupeKey,
          payload: result.payload,
          periodStart,
          periodEnd,
          expiresAt: result.expiresAt || null,
          generatedAt: now,
        },
      });
      await prisma.recommendationEvent.create({
        data: {
          restaurantId,
          recommendationId: createdRec.id,
          ruleId: result.ruleId,
          eventType: 'generated',
          metadata: {
            ruleVersion: result.ruleVersion,
            priority: result.priority,
            confidence: result.confidence,
          },
        },
      });
      created += 1;
    }
  }

  await prisma.insightsState.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      lastEvaluatedAt: now,
      evaluatedDataVersion: ctx.restaurant.dataVersion,
      configFingerprint: ctx.fingerprint,
      configStableSince: ctx.configStableSince,
      maturityStage: ctx.maturityStage,
      weeklySummary,
    },
    update: {
      lastEvaluatedAt: now,
      evaluatedDataVersion: ctx.restaurant.dataVersion,
      configFingerprint: ctx.fingerprint,
      configStableSince: ctx.configStableSince,
      maturityStage: ctx.maturityStage,
      weeklySummary,
    },
  });

  return {
    skipped: false,
    created,
    updated,
    suppressedRuleIds,
    activeCriticalIds,
    maturityStage: ctx.maturityStage,
  };
}

/**
 * Evalúa bajo advisory lock por restaurante (idempotente entre instancias).
 * Solo chequea frescura bajo el lock; NO marca estado fresco antes de evaluar
 * (si la eval falla, el próximo /refresh puede reintentar).
 * La unique de dedupeKey garantiza idempotencia si dos evals se cruzan.
 */
async function evaluateRestaurantWithLock(restaurantId) {
  const lockKey = restaurantIdToLockKey(restaurantId);
  try {
    const gate = await prisma.$transaction(
      async (tx) => {
        const acquired = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS ok`;
        if (!acquired?.[0]?.ok) {
          return { skipped: true, reason: 'lock_held' };
        }

        const state = await tx.insightsState.findUnique({ where: { restaurantId } });
        const restaurant = await tx.restaurant.findUnique({
          where: { id: restaurantId },
          select: { dataVersion: true },
        });
        if (!restaurant) return { skipped: true, reason: 'not_found' };

        if (!isStateStale(state, restaurant.dataVersion)) {
          return { skipped: true, reason: 'fresh' };
        }

        return { shouldEvaluate: true };
      },
      { timeout: 10000, maxWait: 5000 },
    );

    if (!gate?.shouldEvaluate) return gate;
    return evaluateRestaurant(restaurantId);
  } catch (err) {
    logger.warn({ err, restaurantId }, '[insights] evaluateRestaurantWithLock failed');
    throw err;
  }
}

function isStateStale(state, dataVersion) {
  if (!state?.lastEvaluatedAt) return true;
  if (state.evaluatedDataVersion !== dataVersion) return true;
  const ageMs = Date.now() - new Date(state.lastEvaluatedAt).getTime();
  const maxAge = CONTEXT_DEFAULTS.staleAfterHours * 60 * 60 * 1000;
  return ageMs > maxAge;
}

/**
 * Lectura pura — no evalúa, no marca vistas.
 */
async function getInsights(restaurantId, { includeDebug = false } = {}) {
  const visible = isInsightsVisibleForRestaurant(restaurantId);
  if (!visible && !includeDebug) {
    return { enabled: false };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      slug: true,
      name: true,
      dataVersion: true,
      onboardingCompletedAt: true,
      logoUrl: true,
      description: true,
      address: true,
      phone: true,
      bookingContactWhatsapp: true,
      menuPdfUrl: true,
    },
  });
  if (!restaurant) return { enabled: false, error: 'not_found' };

  const [state, recommendations, menuCount, scheduleCount, tableCount, onlineCount] =
    await Promise.all([
      prisma.insightsState.findUnique({ where: { restaurantId } }),
      prisma.recommendation.findMany({
        where: { restaurantId },
        orderBy: { generatedAt: 'desc' },
        take: 50,
      }),
      prisma.restaurantMenu.count({ where: { restaurantId } }),
      prisma.schedule.count({ where: { restaurantId, isActive: true } }),
      prisma.restaurantTable.count({
        where: { isActive: true, zone: { restaurantId, isActive: true } },
      }),
      prisma.reservation.count({ where: { restaurantId, source: 'web' } }),
    ]);

  const now = new Date();
  const activeVisible = sortRecommendations(
    recommendations.filter((r) => isVisibleRecommendation(r, now)),
  );

  const primary =
    activeVisible.find((r) => r.priority !== 'positive') || activeVisible[0] || null;
  const positives = activeVisible.filter(
    (r) => r.priority === 'positive' && r.id !== primary?.id,
  );
  const others = activeVisible.filter(
    (r) => r.id !== primary?.id && r.priority !== 'positive',
  );

  const history = recommendations
    .filter(
      (r) =>
        r.status === 'resolved' ||
        r.status === 'expired' ||
        r.dismissedAt ||
        r.actionTakenAt ||
        r.markedUsefulAt,
    )
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      status: r.status,
      dismissedAt: r.dismissedAt,
      actionTakenAt: r.actionTakenAt,
      markedUsefulAt: r.markedUsefulAt,
      generatedAt: r.generatedAt,
      title: renderRecommendation({
        ruleId: r.ruleId,
        confidence: r.confidence,
        payload: r.payload,
      }).title,
    }));

  const maturityStage = state?.maturityStage || STAGES.CONFIGURACION;
  const showChecklist =
    maturityStage === STAGES.CONFIGURACION || maturityStage === STAGES.ACTIVACION;

  const missingProfile = [];
  if (!restaurant.logoUrl) missingProfile.push('logo');
  if (!restaurant.description?.trim()) missingProfile.push('descripcion');
  if (!restaurant.address?.trim()) missingProfile.push('direccion');
  if (!restaurant.phone?.trim() && !restaurant.bookingContactWhatsapp?.trim()) {
    missingProfile.push('contacto');
  }
  if (!menuCount && !restaurant.menuPdfUrl) missingProfile.push('menu');

  const bookingBase =
    process.env.BOOKING_BASE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'https://simplereserva.com';
  const publicBookingUrl = `${String(bookingBase).replace(/\/$/, '')}/restaurant/${restaurant.slug}`;

  const checklist = showChecklist
    ? buildChecklistPresentation(
        {
          profileComplete: missingProfile.length === 0,
          hasSchedule: scheduleCount > 0,
          hasTables: tableCount > 0,
          hasPublicPage: Boolean(restaurant.slug),
          hasOnlineReservation: onlineCount > 0,
          onboardingComplete: Boolean(restaurant.onboardingCompletedAt),
        },
        publicBookingUrl,
      )
    : null;

  const presented = {
    enabled: visible || includeDebug,
    observationOnly: !visible && includeDebug,
    stale: isStateStale(state, restaurant.dataVersion),
    maturityStage,
    lastEvaluatedAt: state?.lastEvaluatedAt || null,
    weeklySummary: state?.weeklySummary || null,
    checklist,
    primary: primary ? presentRecommendation(primary) : null,
    recommendations: others.map(presentRecommendation),
    positives: positives.map(presentRecommendation),
    history,
    contextual: {
      sin_horarios_activos: activeVisible.some((r) => r.ruleId === 'sin_horarios_activos'),
      ventana_futura_corta: activeVisible.some((r) => r.ruleId === 'ventana_futura_corta'),
      aviso_minimo_alto: activeVisible.some((r) => r.ruleId === 'aviso_minimo_alto'),
    },
  };

  if (includeDebug) {
    presented.debug = {
      evaluatedDataVersion: state?.evaluatedDataVersion,
      dataVersion: restaurant.dataVersion,
      configFingerprint: state?.configFingerprint,
      configStableSince: state?.configStableSince,
      active: activeVisible.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleVersion: r.ruleVersion,
        payload: r.payload,
        priority: r.priority,
        confidence: r.confidence,
      })),
      criticalRuleIds: CRITICAL_RULE_IDS,
    };
  }

  return presented;
}

async function applyUserAction(restaurantId, recommendationId, action, opts = {}) {
  const rec = await prisma.recommendation.findFirst({
    where: { id: recommendationId, restaurantId },
  });
  if (!rec) {
    const err = new Error('Recomendación no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();
  const data = {};
  let eventType = action;

  if (action === 'dismiss') {
    data.dismissedAt = now;
    eventType = 'dismissed';
  } else if (action === 'snooze') {
    const rawDays = opts.days != null ? Number(opts.days) : CONTEXT_DEFAULTS.defaultSnoozeDays;
    const days = Number.isFinite(rawDays)
      ? Math.min(30, Math.max(1, Math.round(rawDays)))
      : CONTEXT_DEFAULTS.defaultSnoozeDays;
    data.snoozedUntil = DateTime.now().plus({ days }).toJSDate();
    eventType = 'snoozed';
  } else if (action === 'action_taken') {
    data.actionTakenAt = now;
    eventType = 'action_taken';
  } else if (action === 'marked_useful') {
    data.markedUsefulAt = now;
    eventType = 'marked_useful';
  } else {
    const err = new Error('Acción no válida');
    err.statusCode = 400;
    throw err;
  }

  const updated = await prisma.recommendation.update({
    where: { id: rec.id },
    data,
  });

  await prisma.recommendationEvent.create({
    data: {
      restaurantId,
      recommendationId: rec.id,
      ruleId: rec.ruleId,
      eventType,
      metadata: opts.days ? { days: opts.days } : undefined,
    },
  });

  return updated;
}

async function recordEvents(restaurantId, events) {
  if (!Array.isArray(events) || !events.length) return { accepted: 0 };
  const allowed = new Set(['impression', 'opened', 'cta_clicked']);
  let accepted = 0;

  for (const ev of events.slice(0, 50)) {
    if (!allowed.has(ev.eventType)) continue;
    if (!ev.recommendationId && !ev.ruleId) continue;

    let rec = null;
    if (ev.recommendationId) {
      rec = await prisma.recommendation.findFirst({
        where: { id: ev.recommendationId, restaurantId },
      });
    }

    const ruleId = ev.ruleId || rec?.ruleId;
    if (!ruleId) continue;

    if (ev.eventType === 'impression' && rec && !rec.firstViewedAt) {
      await prisma.recommendation.update({
        where: { id: rec.id },
        data: { firstViewedAt: new Date() },
      });
    }

    // Strip any accidental PII from metadata
    const metadata = sanitizeEventMetadata(ev.metadata);

    await prisma.recommendationEvent.create({
      data: {
        restaurantId,
        recommendationId: rec?.id || null,
        ruleId,
        eventType: ev.eventType,
        metadata,
      },
    });
    accepted += 1;
  }

  return { accepted };
}

const PII_KEYS = /^(customer|email|phone|name|telefono|correo)/i;

function sanitizeEventMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (PII_KEYS.test(k)) continue;
    if (typeof v === 'string' && v.length > 200) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Assert payload has no PII keys (for tests). */
function payloadHasPii(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const json = JSON.stringify(payload);
  if (/customer(Name|Email|Phone)/i.test(json)) return true;
  if (/"email"\s*:/i.test(json) && /@/.test(json)) return true;
  return false;
}

module.exports = {
  evaluateRestaurant,
  evaluateRestaurantWithLock,
  getInsights,
  applyUserAction,
  recordEvents,
  isVisibleRecommendation,
  isStateStale,
  presentRecommendation,
  sortRecommendations,
  payloadHasPii,
  sanitizeEventMetadata,
  restaurantIdToLockKey,
};
