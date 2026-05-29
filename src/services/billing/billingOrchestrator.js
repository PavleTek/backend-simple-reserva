'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const { computePeriodEnd } = require('../../lib/billingPeriod');
const { resolvePlanChangeType } = require('../../lib/planDisplayOrder');
const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
  resolveBillingStrategy,
  subscriptionBillingView,
  checkoutSessionBillingData,
} = require('../../lib/billingDomain');
const { normalizeBillingInput, getDefaultBillingStrategy } = require('../../lib/billingProviders');
const mercadopagoAdapter = require('./adapters/mercadopagoBillingAdapter');
const {
  switchAutomaticToManualMonthly,
  resolveCollectionMethodChange,
} = require('./collectionMethodSwitchService');
const { orgCanUsePlan } = require('../../lib/orgPlanAccess');
const { canSelfServeBillingOrThrow } = require('../../lib/canSelfServeBilling');
const { getActiveSubscription } = require('../subscriptionService');

/**
 * Programa cambio al fin del periodo sin checkout MP (estrategia manual).
 */
async function schedulePlanChangeInDb({ activeSub, newPlan, when }) {
  const periodEnd = activeSub.currentPeriodEnd
    ? new Date(activeSub.currentPeriodEnd)
    : computePeriodEnd(activeSub.startDate, activeSub.plan);
  if (!periodEnd || Number.isNaN(periodEnd.getTime())) {
    const err = new Error('No se pudo calcular el fin del periodo.');
    err.statusCode = 500;
    throw err;
  }

  await prisma.subscription.update({
    where: { id: activeSub.id },
    data: {
      scheduledPlanId: newPlan.id,
      scheduledChangeAt: periodEnd,
      planChangeWhen: when,
    },
  });

  planService.invalidateCache(activeSub.organizationId);

  return {
    scheduled: true,
    effectiveDate: periodEnd.toISOString(),
    scheduledPlanSku: newPlan.productSKU,
    scheduledPlanName: newPlan.name,
    requiresCheckout: false,
  };
}

/**
 * Ejecuta cambio de plan (checkout o programación DB).
 */
async function executePlanChange({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  when,
  body = {},
  createSubscriptionOptions = {},
}) {
  const whenNorm = when === PLAN_CHANGE_IMMEDIATE ? PLAN_CHANGE_IMMEDIATE : PLAN_CHANGE_END_OF_PERIOD;

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { billingCountry: true, owner: { select: { country: true } } },
  });

  const newPlan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!newPlan) {
    const err = new Error(`Plan no encontrado: ${planSKU}`);
    err.statusCode = 400;
    throw err;
  }
  if (newPlan.comingSoon) {
    const err = new Error('Este plan aún no está disponible.');
    err.statusCode = 400;
    throw err;
  }
  if (!(await orgCanUsePlan(organizationId, newPlan))) {
    const err = new Error('Este plan no está disponible para tu cuenta.');
    err.statusCode = 403;
    throw err;
  }

  const currentSub = await getActiveSubscription(organizationId);
  canSelfServeBillingOrThrow(currentSub);
  if (!currentSub || currentSub.status !== 'active') {
    const err = new Error('Activa un plan de pago antes de cambiar de plan.');
    err.statusCode = 400;
    throw err;
  }
  const currentSubFull = await prisma.subscription.findUnique({
    where: { id: currentSub.id },
    include: { plan: true },
  });
  if (!currentSubFull?.plan) {
    const err = new Error('No pudimos cargar tu suscripción actual.');
    err.statusCode = 400;
    throw err;
  }
  if (currentSubFull.plan.productSKU === planSKU) {
    const err = new Error('Ya tienes este plan activo.');
    err.statusCode = 400;
    throw err;
  }

  const billing = subscriptionBillingView(currentSubFull);
  const billingStrategy = billing.billingStrategy;

  if (whenNorm === PLAN_CHANGE_END_OF_PERIOD && billingStrategy === BILLING_STRATEGY_MANUAL) {
    return schedulePlanChangeInDb({
      activeSub: currentSubFull,
      newPlan,
      when: whenNorm,
    });
  }

  let checkoutStartDateOpt = null;
  if (whenNorm === PLAN_CHANGE_END_OF_PERIOD) {
    const periodEnd = currentSubFull.currentPeriodEnd
      ? new Date(currentSubFull.currentPeriodEnd)
      : computePeriodEnd(currentSubFull.startDate, currentSubFull.plan);
    if (!periodEnd) {
      const err = new Error('No se pudo calcular el fin del periodo.');
      err.statusCode = 500;
      throw err;
    }
    checkoutStartDateOpt = periodEnd;
  }

  const changePlanOpts = checkoutStartDateOpt ? { startDate: checkoutStartDateOpt } : {};

  await prisma.checkoutSession.updateMany({
    where: { organizationId, status: 'pending' },
    data: { status: 'expired' },
  });

  const result = await mercadopagoAdapter.createCheckout({
    organizationId,
    userId,
    payerEmail,
    planSKU,
    restaurantId,
    when: whenNorm === PLAN_CHANGE_END_OF_PERIOD ? 'end_of_period' : 'now',
    billingStrategy,
    pendingChangeFromSubscriptionId: currentSubFull.id,
    createSubscriptionOptions: changePlanOpts,
  });

  await prisma.subscription.update({
    where: { id: currentSubFull.id },
    data: { planChangeWhen: whenNorm },
  });

  planService.invalidateCache(organizationId);

  return {
    scheduled: false,
    checkoutUrl: result.checkoutUrl,
    providerId: result.providerId,
    billingStrategy,
    checkoutHints: result.checkoutHints,
    requiresCheckout: true,
  };
}

/**
 * Actualiza método de cobro (estrategia) — delega a checkout MP.
 */
async function updateCollectionMethod({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  billingStrategy,
  paymentProviderPsp = 'mercadopago',
}) {
  const currentSub = await getActiveSubscription(organizationId);
  canSelfServeBillingOrThrow(currentSub);
  if (!currentSub || currentSub.status !== 'active') {
    const err = new Error('Activa un plan de pago antes de cambiar el método de cobro.');
    err.statusCode = 400;
    throw err;
  }
  const currentSubFull = await prisma.subscription.findUnique({
    where: { id: currentSub.id },
    include: { plan: true },
  });

  const sku = planSKU || currentSubFull?.plan?.productSKU || 'plan-profesional';
  const change = resolveCollectionMethodChange(currentSubFull, billingStrategy);

  if (change.kind === 'noop') {
    const err = new Error('Ya tienes este método de cobro activo.');
    err.statusCode = 400;
    throw err;
  }

  if (change.kind === 'automatic_to_manual') {
    return switchAutomaticToManualMonthly({
      organizationId,
      subscriptionId: currentSubFull.id,
    });
  }

  // manual → automatic (y demás): autorización en Mercado Pago vía preapproval
  return mercadopagoAdapter.createCheckout({
    organizationId,
    userId,
    payerEmail,
    planSKU: sku,
    restaurantId,
    when: 'now',
    billingStrategy,
    pendingChangeFromSubscriptionId: currentSubFull.id,
    createSubscriptionOptions: {},
  });
}

async function resolveScheduledPlanFromSub(activeSub, scheduledMpSub) {
  if (activeSub?.scheduledPlanId && activeSub?.scheduledChangeAt) {
    const scheduledPlan = await prisma.plan.findUnique({
      where: { id: activeSub.scheduledPlanId },
      select: { productSKU: true, name: true },
    });
    return {
      scheduledPlanSku: scheduledPlan?.productSKU ?? null,
      scheduledPlanName: scheduledPlan?.name ?? null,
      scheduledDate: activeSub.scheduledChangeAt.toISOString?.() ?? String(activeSub.scheduledChangeAt),
      source: 'db',
    };
  }
  if (scheduledMpSub && scheduledMpSub.plan) {
    return {
      scheduledPlanSku: scheduledMpSub.plan.productSKU,
      scheduledPlanName: scheduledMpSub.plan.name,
      scheduledDate: scheduledMpSub.startDate?.toISOString() ?? null,
      source: 'mp_scheduled',
    };
  }
  return { scheduledPlanSku: null, scheduledPlanName: null, scheduledDate: null, source: null };
}

module.exports = {
  executePlanChange,
  schedulePlanChangeInDb,
  updateCollectionMethod,
  resolveScheduledPlanFromSub,
  orgCanUsePlan,
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
};
