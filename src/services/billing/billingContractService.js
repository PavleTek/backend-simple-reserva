'use strict';

const prisma = require('../../lib/prisma');
const { canSelfServeBilling } = require('../../lib/canSelfServeBilling');
const { resolvePlanSourceForOrganization, resolvePlanOfferFlags } = require('../../lib/planSource');
const { subscriptionBillingView } = require('../../lib/billingDomain');
const { resolveScheduledPlanFromSub } = require('./billingOrchestrator');

function isSamePlanRenewalScheduled(sub, scheduledSub) {
  if (!sub || !scheduledSub) return false;
  if (sub.status !== 'cancelled' || !sub.endDate || new Date() >= sub.endDate) return false;
  const skuA = sub.plan?.productSKU;
  const skuB = scheduledSub.plan?.productSKU;
  if (!skuA || !skuB || skuA !== skuB) return false;
  if (!scheduledSub.startDate || !sub.endDate) return false;
  const driftMs = Math.abs(
    new Date(scheduledSub.startDate).getTime() - new Date(sub.endDate).getTime(),
  );
  return driftMs <= 48 * 60 * 60 * 1000;
}

/**
 * @param {object} params
 * @param {object|null} params.sub
 * @param {object|null} params.scheduledSub — fila MP status=scheduled
 * @param {boolean} params.renewalScheduledSamePlan
 */
async function buildPendingChange({ sub, scheduledSub, renewalScheduledSamePlan }) {
  if (!sub) return null;

  const dbScheduled = await resolveScheduledPlanFromSub(sub, scheduledSub);

  if (renewalScheduledSamePlan && scheduledSub?.startDate) {
    return {
      type: 'renewal_scheduled',
      planSku: scheduledSub.plan?.productSKU ?? null,
      planName: scheduledSub.plan?.name ?? null,
      effectiveAt: scheduledSub.startDate.toISOString(),
      requiresPayment: true,
      cancelable: true,
      source: 'mp_scheduled',
    };
  }

  if (dbScheduled.scheduledPlanSku && dbScheduled.scheduledDate) {
    const billingView = subscriptionBillingView(sub);
    return {
      type: 'plan_change_scheduled',
      planSku: dbScheduled.scheduledPlanSku,
      planName: dbScheduled.scheduledPlanName,
      effectiveAt: dbScheduled.scheduledDate,
      requiresPayment: billingView.isManual,
      cancelable: true,
      source: dbScheduled.source || 'db',
      when: sub.planChangeWhen || 'end_of_period',
    };
  }

  if (scheduledSub?.plan && !renewalScheduledSamePlan) {
    return {
      type: 'plan_change_scheduled',
      planSku: scheduledSub.plan.productSKU,
      planName: scheduledSub.plan.name,
      effectiveAt: scheduledSub.startDate?.toISOString() ?? null,
      requiresPayment: true,
      cancelable: true,
      source: 'mp_scheduled',
      when: 'end_of_period',
    };
  }

  if (sub.status === 'cancelled' && sub.endDate && new Date() < sub.endDate) {
    return {
      type: 'cancel_at_period_end',
      planSku: sub.plan?.productSKU ?? null,
      planName: sub.plan?.name ?? null,
      effectiveAt: sub.endDate.toISOString(),
      requiresPayment: false,
      cancelable: false,
      source: 'subscription',
    };
  }

  const pendingCheckout = await prisma.checkoutSession.findFirst({
    where: {
      organizationId: sub.organizationId,
      status: 'pending',
      pendingChangeFromSubscriptionId: sub.id,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { productSKU: true, name: true } } },
  });
  if (pendingCheckout) {
    return {
      type: 'payment_required',
      planSku: pendingCheckout.plan?.productSKU ?? null,
      planName: pendingCheckout.plan?.name ?? null,
      effectiveAt: null,
      requiresPayment: true,
      cancelable: false,
      source: 'checkout_session',
      checkoutUrl: pendingCheckout.checkoutUrl ?? null,
    };
  }

  return null;
}

/**
 * @param {object} params
 */
async function buildBillingCapabilities({
  organizationId,
  sub,
  scheduledSub,
  status,
  plan,
}) {
  const gate = canSelfServeBilling(sub);
  const offerFlags = plan?.id ? await resolvePlanOfferFlags(organizationId, plan.id) : {
    selfServicePlanChanges: true,
    selfServiceBillingStrategyChanges: true,
  };

  const isAdminComped = sub?.status === 'cancelled_by_admin';

  const canReactivateBase = !!(sub?.status === 'cancelled' && sub?.endDate && new Date() < sub.endDate);
  const canReactivate = canReactivateBase && !scheduledSub;

  return {
    canChangePlan: gate.allowed && offerFlags.selfServicePlanChanges && !isAdminComped,
    canChangeStrategy:
      gate.allowed && offerFlags.selfServiceBillingStrategyChanges && !isAdminComped && status === 'active',
    canReactivate,
    canRecover: status === 'grace' && !!sub?.isActiveSubscription,
    canActivate: status !== 'active' && status !== 'grace',
    isAdminComped: !!isAdminComped,
    selfServicePlanChanges: offerFlags.selfServicePlanChanges,
    selfServiceBillingStrategyChanges: offerFlags.selfServiceBillingStrategyChanges,
    billingGateCode: gate.code ?? null,
    billingGateReason: gate.allowed ? null : gate.reason,
  };
}

async function buildEntitlementBlock(organizationId, sub, plan) {
  const planSource = plan ? await resolvePlanSourceForOrganization(organizationId, plan) : 'catalog_default';
  return {
    plan: plan
      ? {
          sku: plan.productSKU,
          name: plan.name,
          planSource,
        }
      : null,
    isActive: !!sub?.isActiveSubscription,
    periodEnd: sub?.currentPeriodEnd?.toISOString?.() ?? sub?.endDate?.toISOString?.() ?? null,
    status: sub?.status ?? null,
  };
}

module.exports = {
  buildPendingChange,
  buildBillingCapabilities,
  buildEntitlementBlock,
  isSamePlanRenewalScheduled,
};
