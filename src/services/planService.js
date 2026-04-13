/**
 * Plan resolution engine: resolves effective plan config from Plan.
 * Used for feature flags and limits. Cached for performance.
 */

const prisma = require('../lib/prisma');

// Fallback configs when Plan table/client not available (run: npx prisma generate)
const FALLBACK_CONFIG = {
  'plan-basico': {
    productSKU: 'plan-basico',
    name: 'Básico',
    description: '1 local, ideal para empezar',
    maxRestaurants: 1,
    maxZonesPerRestaurant: 3,
    maxTables: 15,
    maxTeamMembers: 2,
    whatsappFeatures: false,
    googleReserveIntegration: false,
    multipleMenu: false,
    prioritySupport: false,
    priceCLP: 9990,
    priceUSD: 12.99,
    priceEUR: 11.49,
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
  'plan-profesional': {
    productSKU: 'plan-profesional',
    name: 'Profesional',
    description: 'Para quienes tienen más de un local (hasta 3 sedes)',
    maxRestaurants: 3,
    maxZonesPerRestaurant: null,
    maxTables: null,
    maxTeamMembers: 5,
    whatsappFeatures: false,
    googleReserveIntegration: true,
    multipleMenu: true,
    prioritySupport: false,
    priceCLP: 14990,
    priceUSD: 18.99,
    priceEUR: 16.99,
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
  'plan-premium': {
    productSKU: 'plan-premium',
    name: 'Premium',
    description: 'Hasta 20 locales para cadenas',
    maxRestaurants: 20,
    maxZonesPerRestaurant: null,
    maxTables: null,
    maxTeamMembers: null,
    whatsappFeatures: true,
    googleReserveIntegration: true,
    multipleMenu: true,
    prioritySupport: true,
    priceCLP: 39990,
    priceUSD: 44.99,
    priceEUR: 41.99,
    billingFrequency: 1,
    billingFrequencyType: 'months',
  },
};

// In-memory cache: { productSKU: Plan } and { organizationId: { config } }
const planCache = new Map();
const orgConfigCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const VALID_PLANS = ['plan-basico', 'plan-profesional', 'plan-premium'];

const UPGRADE_HINTS = {
  'plan-basico': 'Actualiza a Profesional (hasta 3 locales) o Premium (hasta 20 locales) en Facturación.',
  'plan-profesional': 'Actualiza a Premium (hasta 20 locales) en Facturación.',
  'plan-premium': null, // no upgrade
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
 * Get plan config from DB (with cache). Falls back to FALLBACK_CONFIG if Plan not in Prisma client.
 */
async function getPlanConfig(productSKU) {
  const cached = planCache.get(productSKU);
  if (cached) return cached;

  if (!prisma.plan) {
    const fallback = FALLBACK_CONFIG[productSKU];
    if (fallback) planCache.set(productSKU, fallback);
    return fallback || null;
  }

  try {
    const config = await prisma.plan.findUnique({
      where: { productSKU },
    });
    if (config) planCache.set(productSKU, config);
    return config;
  } catch (err) {
    const fallback = FALLBACK_CONFIG[productSKU];
    if (fallback) planCache.set(productSKU, fallback);
    return fallback || null;
  }
}

/**
 * Get owner's plan from their organization subscription.
 * Uses isActiveSubscription as the sole access indicator.
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
      isActiveSubscription: true,
    },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });
  return sub?.plan ?? null;
}

/**
 * Get owner's plan when in trial.
 * Uses isActiveSubscription as the sole access indicator.
 */
async function getOwnerPlanIncludingTrial(ownerId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { ownerId },
    select: { id: true, plan: true },
  });
  if (!org) return null;

  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId: org.id,
      isActiveSubscription: true,
    },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });
  return sub?.plan ?? null;
}

/**
 * Resolve effective plan config for an owner. Uses cache.
 */
async function resolvePlanConfig(ownerId, includeTrial = true) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { ownerId },
    select: { id: true, plan: true },
  });
  if (!org) return null;

  const cacheKey = `${org.id}:${includeTrial}`;
  const cached = orgConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.config;
  }

  let plan = includeTrial
    ? await getOwnerPlanIncludingTrial(ownerId)
    : await getOwnerPlan(ownerId);

  // Fallback a básico si tiene organización
  if (!plan) plan = org.plan;

  if (!plan) return null;

  orgConfigCache.set(cacheKey, { ts: Date.now(), config: plan });
  return plan;
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
      reason: 'No tienes un plan activo. Ve a Facturación para activar tu suscripción y agregar locales.',
    };
  }

  const max = config.maxRestaurants;
  const planName = config.name || config.productSKU;
  if (count >= max) {
    const hint = UPGRADE_HINTS[config.productSKU];
    const reason = hint
      ? `Tu plan ${planName} no permite agregar más locales (máximo ${max} ${max === 1 ? 'local' : 'locales'}). ${hint}`
      : `Tu plan ${planName} no permite agregar más locales.`;
    return {
      allowed: false,
      reason,
      currentCount: count,
      maxRestaurants: max,
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

  const maxZones = config.maxZonesPerRestaurant;
  if (maxZones == null) return { allowed: true }; // unlimited

  const count = await prisma.zone.count({ where: { restaurantId } });
  if (count >= maxZones) {
    return {
      allowed: false,
      reason: `Tu plan permite hasta ${maxZones} zonas. Actualiza a Profesional para agregar más.`,
      currentCount: count,
      maxZonesPerRestaurant: maxZones,
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
 * Invalidate cache (call when Plan changes).
 */
function invalidateCache(organizationId) {
  if (organizationId) {
    orgConfigCache.delete(`${organizationId}:true`);
    orgConfigCache.delete(`${organizationId}:false`);
  } else {
    orgConfigCache.clear();
  }
  planCache.clear();
}

module.exports = {
  getPlanConfig,
  getOwnerPlan,
  getOwnerPlanIncludingTrial,
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
