'use strict';

const prisma = require('./prisma');

/**
 * Origen del plan para la org (API / UI).
 * @returns {Promise<'catalog_default'|'offer'|'legacy_assigned'|'active_entitlement'>}
 */
async function resolvePlanSourceForOrganization(organizationId, plan) {
  if (!plan?.id) return 'catalog_default';
  if (plan.isDefault) return 'catalog_default';

  const [org, offer, activeSub] = await Promise.all([
    prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: { customPlanId: true },
    }),
    prisma.customPlanOffer.findFirst({
      where: { organizationId, planId: plan.id },
      select: { id: true },
    }),
    prisma.subscription.findFirst({
      where: { organizationId, isActiveSubscription: true, planId: plan.id },
      select: { id: true },
    }),
  ]);

  if (offer) return 'offer';
  if (org?.customPlanId === plan.id) return 'legacy_assigned';
  if (activeSub) return 'active_entitlement';
  return 'offer';
}

/**
 * Flags de self-service desde oferta (default true si no hay oferta).
 */
async function resolvePlanOfferFlags(organizationId, planId) {
  const offer = await prisma.customPlanOffer.findFirst({
    where: { organizationId, planId },
    select: {
      selfServicePlanChanges: true,
      selfServiceBillingStrategyChanges: true,
    },
  });
  return {
    selfServicePlanChanges: offer?.selfServicePlanChanges ?? true,
    selfServiceBillingStrategyChanges: offer?.selfServiceBillingStrategyChanges ?? true,
  };
}

module.exports = {
  resolvePlanSourceForOrganization,
  resolvePlanOfferFlags,
};
