/**
 * Plan resolution engine: resolves effective plan config from PlanConfig + PlanOverride.
 * Used for feature flags and limits. Cached for performance.
 */

const prisma = require('../lib/prisma');

// Fallback configs when PlanConfig table/client not available (run: npx prisma generate)
const FALLBACK_CONFIG = {
  basico: {
    plan: 'basico',
    smsConfirmations: true,
    smsReminders: true,
    whatsappConfirmations: true,
    whatsappReminders: true,
    whatsappModificationAlerts: true,
    menuPdf: false,
    advancedBookingSettings: false,
    brandingRemoval: false,
    analyticsWeekly: false,
    analyticsMonthly: false,
    crossLocationDashboard: false,
    prioritySupport: false,
    maxLocations: 1,
    maxZones: 3,
    maxTables: 15,
    maxTeamMembers: 2,
    biweeklyPriceCLP: 2990,
    currency: 'CLP',
    billingFrequencyDays: 14,
  },
  profesional: {
    plan: 'profesional',
    smsConfirmations: true,
    smsReminders: true,
    whatsappConfirmations: true,
    whatsappReminders: true,
    whatsappModificationAlerts: true,
    menuPdf: true,
    advancedBookingSettings: true,
    brandingRemoval: true,
    analyticsWeekly: true,
    analyticsMonthly: true,
    crossLocationDashboard: true,
    prioritySupport: false,
    maxLocations: 3,
    maxZones: null,
    maxTables: null,
    maxTeamMembers: 5,
    biweeklyPriceCLP: 4990,
    currency: 'CLP',
    billingFrequencyDays: 14,
  },
  premium: {
    plan: 'premium',
    smsConfirmations: true,
    smsReminders: true,
    whatsappConfirmations: true,
    whatsappReminders: true,
    whatsappModificationAlerts: true,
    menuPdf: true,
    advancedBookingSettings: true,
    brandingRemoval: true,
    analyticsWeekly: true,
    analyticsMonthly: true,
    crossLocationDashboard: true,
    prioritySupport: true,
    maxLocations: 20,
    maxZones: null,
    maxTables: null,
    maxTeamMembers: null,
    biweeklyPriceCLP: 9990,
    currency: 'CLP',
    billingFrequencyDays: 14,
  },
};

// In-memory cache: { planKey: PlanConfig } and { ownerId: { override, config } }
// TTL: config is long-lived; override+config per owner cached for 60s
const planConfigCache = new Map();
const ownerConfigCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const VALID_PLANS = ['basico', 'profesional', 'premium'];

const PLAN_LABELS = { basico: 'Básico', profesional: 'Profesional', premium: 'Premium' };

const UPGRADE_HINTS = {
  basico: 'Actualiza a Profesional (hasta 3 locales) o Premium (hasta 20 locales) en Facturación.',
  profesional: 'Actualiza a Premium (hasta 20 locales) en Facturación.',
  premium: null, // no upgrade
};

/**
 * Get plan config from DB (with cache). Falls back to FALLBACK_CONFIG if PlanConfig not in Prisma client.
 */
async function getPlanConfig(planKey) {
  if (!VALID_PLANS.includes(planKey)) return null;
  const cached = planConfigCache.get(planKey);
  if (cached) return cached;

  if (!prisma.planConfig) {
    const fallback = FALLBACK_CONFIG[planKey];
    if (fallback) planConfigCache.set(planKey, fallback);
    return fallback || null;
  }

  try {
    const config = await prisma.planConfig.findUnique({
      where: { plan: planKey },
    });
    if (config) planConfigCache.set(planKey, config);
    return config;
  } catch (err) {
    const fallback = FALLBACK_CONFIG[planKey];
    if (fallback) planConfigCache.set(planKey, fallback);
    return fallback || null;
  }
}

/**
 * Get owner's plan from their subscriptions (any restaurant they own).
 * Returns plan key or null.
 */
async function getOwnerPlan(ownerId) {
  const ownerRestaurants = await prisma.userRestaurant.findMany({
    where: { userId: ownerId, role: 'owner' },
    select: { restaurantId: true },
  });
  if (ownerRestaurants.length === 0) return null;

  const restaurantIds = ownerRestaurants.map((r) => r.restaurantId);

  // Get active subscription from any of owner's restaurants
  const sub = await prisma.subscription.findFirst({
    where: {
      restaurantId: { in: restaurantIds },
      status: { in: ['active', 'trial', 'cancelled'] },
    },
    orderBy: { startDate: 'desc' },
  });
  if (!sub) return null;

  if (sub.status === 'cancelled' && sub.endDate && new Date() > sub.endDate) {
    return null;
  }

  return sub.plan && VALID_PLANS.includes(sub.plan) ? sub.plan : 'profesional';
}

/**
 * Get owner's plan when in trial (trial = básico, sin tarjeta).
 */
async function getOwnerPlanIncludingTrial(ownerId) {
  const ownerRestaurants = await prisma.userRestaurant.findMany({
    where: { userId: ownerId, role: 'owner' },
    select: { restaurantId: true },
  });
  if (ownerRestaurants.length === 0) return null;

  const restaurantIds = ownerRestaurants.map((r) => r.restaurantId);

  for (const rid of restaurantIds) {
    const r = await prisma.restaurant.findUnique({
      where: { id: rid },
      select: { trialEndsAt: true },
    });
    if (r?.trialEndsAt && new Date() < r.trialEndsAt) {
      return 'basico';
    }
  }

  return getOwnerPlan(ownerId);
}

/**
 * Get PlanOverride for owner if exists and not expired.
 */
async function getPlanOverride(ownerId) {
  if (!prisma.planOverride) return null;
  try {
    const override = await prisma.planOverride.findUnique({
      where: { userId: ownerId },
    });
    if (!override) return null;
    if (override.expiresAt && new Date() > override.expiresAt) return null;
    return override;
  } catch (err) {
    return null;
  }
}

/**
 * Merge plan config with override. Override fields take precedence when not null.
 */
function mergeConfigWithOverride(config, override) {
  if (!config) return null;
  if (!override) return config;

  const merged = { ...config };

  if (override.biweeklyPriceCLP != null) merged.biweeklyPriceCLP = override.biweeklyPriceCLP;
  if (override.menuPdf != null) merged.menuPdf = override.menuPdf;
  if (override.advancedBookingSettings != null) merged.advancedBookingSettings = override.advancedBookingSettings;
  if (override.brandingRemoval != null) merged.brandingRemoval = override.brandingRemoval;
  if (override.analyticsWeekly != null) merged.analyticsWeekly = override.analyticsWeekly;
  if (override.analyticsMonthly != null) merged.analyticsMonthly = override.analyticsMonthly;
  if (override.crossLocationDashboard != null) merged.crossLocationDashboard = override.crossLocationDashboard;
  if (override.prioritySupport != null) merged.prioritySupport = override.prioritySupport;
  if (override.maxLocations != null) merged.maxLocations = override.maxLocations;
  if (override.maxZones != null) merged.maxZones = override.maxZones;
  if (override.maxTables != null) merged.maxTables = override.maxTables;
  if (override.maxTeamMembers != null) merged.maxTeamMembers = override.maxTeamMembers;

  return merged;
}

/**
 * Resolve effective plan config for an owner. Uses cache.
 * @param {string} ownerId - User id of the owner
 * @param {boolean} includeTrial - If true, trial gives básico access
 */
async function resolvePlanConfig(ownerId, includeTrial = true) {
  const cacheKey = `${ownerId}:${includeTrial}`;
  const cached = ownerConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.config;
  }

  const planKey = includeTrial
    ? await getOwnerPlanIncludingTrial(ownerId)
    : await getOwnerPlan(ownerId);
  if (!planKey) return null;

  const config = await getPlanConfig(planKey);
  if (!config) return null;

  const override = await getPlanOverride(ownerId);
  const resolved = mergeConfigWithOverride(config, override);

  ownerConfigCache.set(cacheKey, { ts: Date.now(), config: resolved });
  return resolved;
}

/**
 * Resolve plan config for a restaurant (via its owner).
 */
async function resolvePlanConfigForRestaurant(restaurantId, includeTrial = true) {
  const ownerLink = await prisma.userRestaurant.findFirst({
    where: { restaurantId, role: 'owner' },
    select: { userId: true },
  });
  if (!ownerLink) return null;
  return resolvePlanConfig(ownerLink.userId, includeTrial);
}

/**
 * Check if owner has access to a feature.
 */
async function hasFeature(ownerId, featureKey, includeTrial = true) {
  const config = await resolvePlanConfig(ownerId, includeTrial);
  if (!config) return false;
  return config[featureKey] === true;
}

/**
 * Get effective limit value (null = unlimited).
 */
async function getLimit(ownerId, limitKey, includeTrial = true) {
  const config = await resolvePlanConfig(ownerId, includeTrial);
  if (!config) return null;
  return config[limitKey] ?? null;
}

/**
 * Check if owner can add another location.
 */
async function canAddLocation(ownerId, includeTrial = true) {
  let config = await resolvePlanConfig(ownerId, includeTrial);
  const count = await prisma.userRestaurant.count({
    where: { userId: ownerId, role: 'owner' },
  });

  // Usuario con restaurantes: siempre tiene plan (básico como mínimo). Si no se resuelve, usar básico.
  if (!config && count > 0) {
    config = await getPlanConfig('basico') || FALLBACK_CONFIG.basico;
  }
  if (!config) {
    return {
      allowed: false,
      reason: 'No tienes un plan activo. Ve a Facturación para activar tu suscripción y agregar ubicaciones.',
    };
  }

  const max = config.maxLocations;
  const planName = PLAN_LABELS[config.plan] || config.plan;
  if (count >= max) {
    const hint = UPGRADE_HINTS[config.plan];
    const reason = hint
      ? `Tu plan ${planName} no permite agregar más locales (máximo ${max} ${max === 1 ? 'local' : 'locales'}). ${hint}`
      : `Tu plan ${planName} no permite agregar más locales.`;
    return {
      allowed: false,
      reason,
      currentCount: count,
      maxLocations: max,
    };
  }
  return { allowed: true };
}

/**
 * Check if restaurant can add another zone.
 */
async function canAddZone(restaurantId, includeTrial = true) {
  const config = await resolvePlanConfigForRestaurant(restaurantId, includeTrial);
  if (!config) return { allowed: false, reason: 'Sin plan activo' };

  const maxZones = config.maxZones;
  if (maxZones == null) return { allowed: true }; // unlimited

  const count = await prisma.zone.count({ where: { restaurantId } });
  if (count >= maxZones) {
    return {
      allowed: false,
      reason: `Tu plan permite hasta ${maxZones} zonas. Actualiza a Profesional para agregar más.`,
      currentCount: count,
      maxZones,
    };
  }
  return { allowed: true };
}

/**
 * Check if restaurant can add another table.
 */
async function canAddTable(restaurantId, includeTrial = true) {
  const config = await resolvePlanConfigForRestaurant(restaurantId, includeTrial);
  if (!config) return { allowed: false, reason: 'Sin plan activo' };

  const maxTables = config.maxTables;
  if (maxTables == null) return { allowed: true }; // unlimited

  const count = await prisma.restaurantTable.count({
    where: { zone: { restaurantId } },
  });
  if (count >= maxTables) {
    return {
      allowed: false,
      reason: `Tu plan permite hasta ${maxTables} mesas. Actualiza a Profesional para agregar más.`,
      currentCount: count,
      maxTables,
    };
  }
  return { allowed: true };
}

/**
 * Check if owner can add another team member to a restaurant.
 */
async function canAddTeamMember(ownerId, restaurantId, includeTrial = true) {
  const config = await resolvePlanConfig(ownerId, includeTrial);
  if (!config) return { allowed: false, reason: 'Sin plan activo' };

  const maxTeam = config.maxTeamMembers;
  if (maxTeam == null) return { allowed: true }; // unlimited

  const ownerLink = await prisma.userRestaurant.findFirst({
    where: { restaurantId, role: 'owner' },
    select: { userId: true },
  });
  if (!ownerLink) return { allowed: false };

  const teamCount = await prisma.userRestaurant.count({
    where: { restaurantId },
  });
  if (teamCount >= maxTeam) {
    return {
      allowed: false,
      reason: `Tu plan permite hasta ${maxTeam} miembros por local. Actualiza tu plan para agregar más.`,
      currentCount: teamCount,
      maxTeamMembers: maxTeam,
    };
  }
  return { allowed: true };
}

/**
 * Invalidate cache (call when PlanConfig or PlanOverride changes).
 */
function invalidateCache(ownerId) {
  if (ownerId) {
    for (const key of ownerConfigCache.keys()) {
      if (key.startsWith(`${ownerId}:`)) ownerConfigCache.delete(key);
    }
  } else {
    ownerConfigCache.clear();
  }
  planConfigCache.clear();
}

module.exports = {
  getPlanConfig,
  getOwnerPlan,
  getOwnerPlanIncludingTrial,
  getPlanOverride,
  resolvePlanConfig,
  resolvePlanConfigForRestaurant,
  hasFeature,
  getLimit,
  canAddLocation,
  canAddZone,
  canAddTable,
  canAddTeamMember,
  invalidateCache,
  VALID_PLANS,
};
