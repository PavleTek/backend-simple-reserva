'use strict';

/**
 * Configuración versionada del motor de sugerencias.
 * Cambiar un umbral implica subir INSIGHT_RULES_VERSION.
 */

const INSIGHT_RULES_VERSION = 1;

const STAGES = {
  CONFIGURACION: 'configuracion',
  ACTIVACION: 'activacion',
  APRENDIZAJE: 'aprendizaje',
  INSIGHTS: 'insights',
};

const STAGE_ORDER = [
  STAGES.CONFIGURACION,
  STAGES.ACTIVACION,
  STAGES.APRENDIZAJE,
  STAGES.INSIGHTS,
];

/** Prioridad numérica (mayor = más urgente). */
const PRIORITY_RANK = {
  critical: 100,
  high: 80,
  medium: 50,
  low: 20,
  positive: 10,
};

const CRITICAL_RULE_IDS = [
  'sin_horarios_activos',
  'sin_mesas_activas',
  'proximos_dias_sin_cupos',
];

const RULE_DEFAULTS = {
  sin_horarios_activos: {
    version: 1,
    category: 'configuracion',
    priority: 'critical',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 0,
  },
  sin_mesas_activas: {
    version: 1,
    category: 'configuracion',
    priority: 'critical',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 0,
  },
  proximos_dias_sin_cupos: {
    version: 1,
    category: 'configuracion',
    priority: 'critical',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 0,
    futureDays: 7,
  },
  sin_reservas_online_recientes: {
    version: 1,
    category: 'conseguir_reservas',
    priority: 'high',
    confidence: 'medium',
    stages: [STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: CRITICAL_RULE_IDS,
    cooldownDays: 7,
    lookbackDays: 7,
    minOpenDaysWithSlots: 2,
    lowTrafficSessions: 5,
  },
  caida_de_reservas: {
    version: 1,
    category: 'rendimiento',
    priority: 'high',
    confidence: 'medium',
    stages: [STAGES.INSIGHTS],
    suppressedBy: CRITICAL_RULE_IDS,
    cooldownDays: 14,
    dropThreshold: 0.4,
    minBaselineWeeklyReceived: 5,
    minComparableWeeks: 2,
    maxComparableWeeks: 4,
  },
  ventana_futura_corta: {
    version: 1,
    category: 'configuracion',
    priority: 'medium',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 30,
    maxDays: 7,
  },
  aviso_minimo_alto: {
    version: 1,
    category: 'configuracion',
    priority: 'medium',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 30,
    minMinutes: 1440,
  },
  perfil_incompleto: {
    version: 1,
    category: 'configuracion',
    priority: 'medium',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 14,
  },
  sin_datos_contacto: {
    version: 1,
    category: 'configuracion',
    priority: 'medium',
    confidence: 'high',
    stages: [STAGES.ACTIVACION, STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 30,
  },
  dias_proximos_con_cupos: {
    version: 1,
    category: 'conseguir_reservas',
    priority: 'medium',
    confidence: 'medium',
    stages: [STAGES.APRENDIZAJE, STAGES.INSIGHTS],
    suppressedBy: CRITICAL_RULE_IDS,
    cooldownDays: 7,
    futureDays: 7,
    minFreeSlots: 4,
    minFreeRatio: 0.5,
  },
  tendencia_positiva: {
    version: 1,
    category: 'rendimiento',
    priority: 'positive',
    confidence: 'medium',
    stages: [STAGES.INSIGHTS],
    suppressedBy: [],
    cooldownDays: 14,
    growthThreshold: 0.25,
    minWeeklyReceived: 3,
    minComparableWeeks: 2,
    maxComparableWeeks: 4,
  },
};

const CONTEXT_DEFAULTS = {
  historyWeeks: 8,
  recentReceivedDays: 14,
  funnelDays: 14,
  futureAvailabilityDays: 7,
  maturityMinDays: 14,
  maturityMinOnlineReceived: 10,
  insightsMinComparableWeeks: 4,
  insightsMinReceived8Weeks: 30,
  staleAfterHours: 24,
  defaultSnoozeDays: 7,
  partySizeFallback: 2,
};

function parseAllowlist() {
  const raw = process.env.INSIGHTS_RESTAURANT_ALLOWLIST || '';
  if (!raw.trim()) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isInsightsEnabledGlobally() {
  return process.env.INSIGHTS_ENABLED === 'true';
}

function isObservationMode() {
  return process.env.INSIGHTS_OBSERVATION_MODE === 'true';
}

/**
 * ¿El panel debe mostrar sugerencias a este restaurante?
 * En modo observación nunca se muestran (solo se evalúan).
 * Con allowlist, solo esos IDs; sin allowlist y enabled=true → todos.
 */
function isInsightsVisibleForRestaurant(restaurantId) {
  if (!isInsightsEnabledGlobally()) return false;
  if (isObservationMode()) return false;
  const allowlist = parseAllowlist();
  if (allowlist) return allowlist.has(restaurantId);
  return true;
}

/** ¿Se debe evaluar este restaurante (cron / refresh)? */
function shouldEvaluateRestaurant(restaurantId) {
  if (!isInsightsEnabledGlobally()) return false;
  const allowlist = parseAllowlist();
  // En observación se evalúa para todos; allowlist solo limita UI
  if (isObservationMode()) return true;
  if (allowlist) return allowlist.has(restaurantId);
  return true;
}

function ruleVersionString(ruleId) {
  const def = RULE_DEFAULTS[ruleId];
  const v = def?.version ?? 1;
  return `${ruleId}@${v}`;
}

function stageAtLeast(stage, minimum) {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(minimum);
}

module.exports = {
  INSIGHT_RULES_VERSION,
  STAGES,
  STAGE_ORDER,
  PRIORITY_RANK,
  CRITICAL_RULE_IDS,
  RULE_DEFAULTS,
  CONTEXT_DEFAULTS,
  isInsightsEnabledGlobally,
  isObservationMode,
  isInsightsVisibleForRestaurant,
  shouldEvaluateRestaurant,
  ruleVersionString,
  stageAtLeast,
};
