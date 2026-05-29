'use strict';

const prisma = require('./prisma');

/**
 * IDs de planes que la organización puede contratar o ver en billing.
 * Misma regla que GET /subscription (públicos + customPlan legacy + CustomPlanOffer + sub activa).
 */
async function listPlanIdsAvailableToOrganization(organizationId) {
  const [org, publicPlans, planOffers, activeSub] = await Promise.all([
    prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: { customPlanId: true },
    }),
    prisma.plan.findMany({ where: { isDefault: true }, select: { id: true } }),
    prisma.customPlanOffer.findMany({
      where: { organizationId },
      select: { planId: true },
    }),
    prisma.subscription.findFirst({
      where: { organizationId, isActiveSubscription: true },
      orderBy: { startDate: 'desc' },
      select: { planId: true },
    }),
  ]);

  const ids = new Set(publicPlans.map((p) => p.id));
  if (org?.customPlanId) ids.add(org.customPlanId);
  for (const offer of planOffers) ids.add(offer.planId);
  if (activeSub?.planId) ids.add(activeSub.planId);

  return ids;
}

/**
 * @param {string} organizationId
 * @param {{ id: string, isDefault?: boolean }} plan
 */
async function orgCanUsePlan(organizationId, plan) {
  if (!plan?.id) return false;
  if (plan.isDefault) return true;

  const allowedIds = await listPlanIdsAvailableToOrganization(organizationId);
  return allowedIds.has(plan.id);
}

module.exports = {
  listPlanIdsAvailableToOrganization,
  orgCanUsePlan,
};
