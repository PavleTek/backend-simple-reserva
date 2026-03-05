/**
 * Plan resolution engine: resolves effective plan config from PlanConfig + PlanOverride.
 * Used for feature flags and limits. Cached for performance.
 */

const prisma = require('../lib/prisma');

// Fallback configs when PlanConfig table/client not available (run: npx prisma generate)
const FALLBACK_CONFIG = {
  basico: {
    plan: 'basico',
    displayName: 'Básico',
    description: '1 local, ideal para empezar',
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
    priceCLP: 2990,
    currency: 'CLP',
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
  profesional: {
    plan: 'profesional',
    displayName: 'Profesional',
    description: 'Hasta 3 locales para tu negocio en crecimiento',
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
    priceCLP: 4990,
    currency: 'CLP',
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
  premium: {
    plan: 'premium',
    displayName: 'Premium',
    description: 'Hasta 20 locales para cadenas',
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
    priceCLP: 9990,
    currency: 'CLP',
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
};

// In-memory cache: { planKey: PlanConfig } and { organizationId: { override, config } }
const planConfigCache = new Map();
const orgConfigCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const VALID_PLANS = ['basico', 'profesional', 'premium'];

const UPGRADE_HINTS = {
  basico: 'Actualiza a Profesional (hasta 3 locales) o Premium (hasta 20 locales) en Facturación.',
  profesional: 'Actualiza a Premium (hasta 20 locales) en Facturación.',
  premium: null, // no upgrade
};

/**
 * Helper to translate frequency to Mercado Pago format.
 */
function toMercadoPagoFrequency(billingFrequency, billingFrequencyType) {
  switch (billingFrequencyType) {
    case 'days':
      return { frequency: billingFrequency, frequency_type: 'days' };
    case 'weeks':
      return { frequency: billingFrequency * 7, frequency_type: 'days' };
    case 'months':
      return { frequency: billingFrequency, frequency_type: 'months' };
    case 'yearly':
      return { frequency: billingFrequency * 12, frequency_type: 'months' };
    default:
      return { frequency: billingFrequency, frequency_type: 'months' };
  }
}

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
 * Get owner's plan from their organization subscription.
 */
async function getOwnerPlan(ownerId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { ownerId },
    select: { id: true },
  });
  if (!org) return null;

  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId: org.id,
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
 * Get owner's plan when in trial.
 */
async function getOwnerPlanIncludingTrial(ownerId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { ownerId },
    select: { id: true, trialEndsAt: true },
  });
  if (!org) return null;

  // Primero buscar subscription (trial o activa) para obtener el plan real
  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId: org.id,
      status: { in: ['trial', 'active', 'grace'] },
    },
    orderBy: { startDate: 'desc' },
    select: { plan: true },
  });
  if (sub?.plan && VALID_PLANS.includes(sub.plan)) {
    return sub.plan;
  }

  // Legacy/Trial: trialEndsAt en futuro
  if (org.trialEndsAt && org.trialEndsAt > new Date()) {
    return 'basico';
  }

  return getOwnerPlan(ownerId);
}

/**
 * Get PlanOverride for organization if exists and not expired.
 */
async function getPlanOverride(organizationId) {
  if (!prisma.planOverride) return null;
  try {
    const override = await prisma.planOverride.findUnique({
      where: { organizationId },
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

  if (override.priceCLP != null) merged.priceCLP = override.priceCLP;
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
 */
async function resolvePlanConfig(ownerId, includeTrial = true) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { ownerId },
    select: { id: true },
  });
  if (!org) return null;

  const cacheKey = `${org.id}:${includeTrial}`;
  const cached = orgConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.config;
  }

  let planKey = includeTrial
    ? await getOwnerPlanIncludingTrial(ownerId)
    : await getOwnerPlan(ownerId);

  // Fallback a básico si tiene organización
  if (!planKey) planKey = 'basico';

  const config = await getPlanConfig(planKey) || FALLBACK_CONFIG[planKey];
  if (!config) return null;

  const override = await getPlanOverride(org.id);
  const resolved = mergeConfigWithOverride(config, override);

  orgConfigCache.set(cacheKey, { ts: Date.now(), config: resolved });
  return resolved;
}

/**
 * Resolve plan config for a restaurant (via its organization).
 */
async function resolvePlanConfigForRestaurant(restaurantId, includeTrial = true) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { organizationId: true },
  });
  if (!restaurant) return null;

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: restaurant.organizationId },
    select: { ownerId: true },
  });
  if (!org) return null;

  return resolvePlanConfig(org.ownerId, includeTrial);
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
  const config = await resolvePlanConfig(ownerId, includeTrial);
  const count = await prisma.restaurant.count({
    where: { organization: { ownerId } },
  });

  if (!config) {
    return {
      allowed: false,
      reason: 'No tienes un plan activo. Ve a Facturación para activar tu suscripción y agregar ubicaciones.',
    };
  }

  const max = config.maxLocations;
  const planName = config.displayName || config.plan;
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

  const teamCount = await prisma.organizationManager.count({
    where: {
      organization: { ownerId },
      restaurantAssignments: { some: { restaurantId } }
    },
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
function invalidateCache(organizationId) {
  if (organizationId) {
    orgConfigCache.delete(`${organizationId}:true`);
    orgConfigCache.delete(`${organizationId}:false`);
  } else {
    orgConfigCache.clear();
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
  toMercadoPagoFrequency,
  VALID_PLANS,
};
