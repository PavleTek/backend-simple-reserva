'use strict';

const prisma = require('../../lib/prisma');
const { getActiveSubscription } = require('../subscriptionService');
const { computePeriodEnd } = require('../../lib/billingPeriod');
const { priceWithIva } = require('./billingOverviewService');
const { resolvePlanChangeType } = require('../../lib/planDisplayOrder');
const {
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  subscriptionBillingView,
  collectionMethodLabel,
  normalizePlanChangeWhen,
} = require('../../lib/billingDomain');
const { orgCanUsePlan } = require('../../lib/orgPlanAccess');
const { canSelfServeBilling } = require('../../lib/canSelfServeBilling');
const { resolvePlanOfferFlags } = require('../../lib/planSource');
const { resolvePlanChangePreviewFlags } = require('../../lib/billingFlowMatrix');
const referralService = require('../referralService');
const {
  evaluatePlanChangeReferralPolicy,
  isReferralCreditPeriodLocked,
} = require('./referralCreditGuardService');

function formatEffectDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return String(isoDate).slice(0, 10);
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function planFeaturesSummary(plan) {
  const features = [];
  if (plan.maxRestaurants != null) features.push(`Hasta ${plan.maxRestaurants} local${plan.maxRestaurants === 1 ? '' : 'es'}`);
  if (plan.maxTables != null) features.push(`Hasta ${plan.maxTables} mesas`);
  if (plan.whatsappFeatures) features.push('WhatsApp');
  if (plan.multipleMenu) features.push('Menús múltiples');
  if (plan.prioritySupport) features.push('Soporte prioritario');
  if (plan.postVisitFeedback) features.push('Feedback post-visita');
  return features;
}

function diffFeatures(currentPlan, newPlan) {
  const current = new Set(planFeaturesSummary(currentPlan));
  const next = new Set(planFeaturesSummary(newPlan));
  const gained = [...next].filter((f) => !current.has(f));
  const lost = [...current].filter((f) => !next.has(f));
  return { gained, lost };
}

function buildPreviewForWhen({
  when,
  periodEndIso,
  effectiveDate,
  currentPlan,
  newPlan,
  currentPrice,
  newPrice,
  tierChange,
  billingStrategy,
}) {
  const isUpgrade = tierChange === 'upgrade';
  const { gained, lost } = diffFeatures(currentPlan, newPlan);

  if (when === PLAN_CHANGE_IMMEDIATE) {
    const chargeNow = newPrice.withIva;
    return {
      currentPlan: {
        name: currentPlan?.name,
        sku: currentPlan?.productSKU,
        price: currentPrice.base,
        priceWithIVA: currentPrice.withIva,
      },
      newPlan: {
        name: newPlan.name,
        sku: newPlan.productSKU,
        price: newPrice.base,
        priceWithIVA: newPrice.withIva,
      },
      chargeNow,
      chargeDate: effectiveDate,
      nextCharge: {
        amount: newPrice.withIva,
        date: effectiveDate,
      },
      noProration: true,
      fullMonthCharge: true,
      gainedFeatures: gained,
      lostFeatures: lost,
      isUpgrade,
      appliesNow: `Se cobrará el mes completo del plan ${newPlan.name} (${chargeNow.toLocaleString('es-CL')} CLP con IVA) y tu ciclo reinicia desde hoy.`,
      appliesLater: null,
      billingStrategy,
      collectionMethodLabel: collectionMethodLabel(billingStrategy),
    };
  }

  return {
    currentPlan: {
      name: currentPlan?.name,
      sku: currentPlan?.productSKU,
      price: currentPrice.base,
      priceWithIVA: currentPrice.withIva,
    },
    newPlan: {
      name: newPlan.name,
      sku: newPlan.productSKU,
      price: newPrice.base,
      priceWithIVA: newPrice.withIva,
    },
    chargeNow: 0,
    chargeDate: effectiveDate,
    nextCharge: {
      amount: newPrice.withIva,
      date: effectiveDate,
    },
    noProration: true,
    previousPlanCancelledAt: effectiveDate,
    previousPlanRefund: 0,
    gainedFeatures: gained,
    lostFeatures: lost,
    isUpgrade,
    appliesNow: 'Sigues con tu plan actual hasta esa fecha.',
    appliesLater: `El ${formatEffectDate(periodEndIso)} cambias a ${newPlan.name}.`,
    billingStrategy,
    collectionMethodLabel: collectionMethodLabel(billingStrategy),
  };
}

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.planSKU
 * @param {string} [params.when] immediate | end_of_period
 * @param {boolean} [params.confirmForfeitReferralCredits]
 */
async function previewChangePlan({ organizationId, planSKU, when: rawWhen, confirmForfeitReferralCredits = false }) {
  const sku = String(planSKU || '').trim();
  if (!sku) {
    return { allowed: false, error: 'Debes indicar el plan a previsualizar.' };
  }

  const sub = await getActiveSubscription(organizationId);
  const gate = canSelfServeBilling(sub);
  if (!gate.allowed) {
    return { allowed: false, error: gate.reason, code: gate.code };
  }
  if (sub.status !== 'active') {
    return {
      allowed: false,
      error: 'Activa un plan de pago antes de cambiar de plan.',
      code: 'trial_checkout_required',
    };
  }

  const newPlan = await prisma.plan.findUnique({ where: { productSKU: sku } });
  if (!newPlan) {
    return { allowed: false, error: `Plan no encontrado: ${planSKU}` };
  }
  if (newPlan.comingSoon) {
    return { allowed: false, error: 'Este plan aún no está disponible.' };
  }
  if (!(await orgCanUsePlan(organizationId, newPlan))) {
    return { allowed: false, error: 'Este plan no está disponible para tu cuenta.' };
  }

  if (sub.plan?.productSKU === sku || sub.planId === newPlan.id) {
    return { allowed: false, error: 'Ya tienes este plan activo.' };
  }

  const currentPlan =
    sub.plan ||
    (await prisma.plan.findUnique({ where: { id: sub.planId } }));
  if (!currentPlan) {
    return {
      allowed: false,
      error: 'No pudimos cargar tu plan actual. Si el problema continúa, contacta a soporte.',
    };
  }

  const offerFlags = await resolvePlanOfferFlags(organizationId, currentPlan.id);
  if (!offerFlags.selfServicePlanChanges) {
    return {
      allowed: false,
      error: 'Los cambios de plan de tu cuenta están gestionados por SimpleReserva. Contacta a soporte.',
      code: 'plan_changes_managed',
    };
  }

  const creditsAvailableDays = await referralService.getAvailableCreditDays(organizationId);
  const referralPolicy = evaluatePlanChangeReferralPolicy({
    sub,
    currentSku: currentPlan.productSKU,
    newSku: sku,
    creditsAvailableDays,
    confirmForfeitReferralCredits,
  });

  if (!referralPolicy.allowed) {
    return {
      allowed: false,
      error: referralPolicy.error,
      code: referralPolicy.code,
      referralPlanChangeBlocked: referralPolicy.planChangeBlocked ?? false,
      referralForfeitRequired: referralPolicy.requiresForfeitConfirmation ?? false,
      referralCreditsAvailableDays: referralPolicy.creditsAvailableDays ?? creditsAvailableDays,
      referralSameTierOnly: referralPolicy.sameTierOnly ?? false,
    };
  }

  const currentPrice = priceWithIva(currentPlan.priceCLP ?? 0);
  const newPrice = priceWithIva(newPlan.priceCLP);

  let periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  if (!periodEnd || Number.isNaN(periodEnd.getTime())) {
    periodEnd = computePeriodEnd(sub.startDate, currentPlan);
  }
  if (!periodEnd || Number.isNaN(periodEnd.getTime())) {
    return {
      allowed: false,
      error:
        'No pudimos calcular la fecha de fin de tu periodo actual. Si el problema continúa, contacta a soporte.',
    };
  }

  const periodEndIso = periodEnd.toISOString();
  const effectiveDate = periodEndIso.slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const billingView = subscriptionBillingView(sub);
  const billingStrategy = billingView.billingStrategy;
  const tierChange = resolvePlanChangeType(currentPlan?.productSKU, newPlan.productSKU);
  const changeType = tierChange === 'upgrade' || tierChange === 'downgrade' ? tierChange : 'change';
  const recommendedWhen =
    tierChange === 'upgrade' ? PLAN_CHANGE_IMMEDIATE : PLAN_CHANGE_END_OF_PERIOD;

  const when = rawWhen ? normalizePlanChangeWhen(rawWhen) : recommendedWhen;

  const previewImmediate = buildPreviewForWhen({
    when: PLAN_CHANGE_IMMEDIATE,
    periodEndIso: todayIso,
    effectiveDate: todayIso,
    currentPlan,
    newPlan,
    currentPrice,
    newPrice,
    tierChange,
    billingStrategy,
  });

  const previewEndOfPeriod = buildPreviewForWhen({
    when: PLAN_CHANGE_END_OF_PERIOD,
    periodEndIso,
    effectiveDate,
    currentPlan,
    newPlan,
    currentPrice,
    newPrice,
    tierChange,
    billingStrategy,
  });

  const effectMessage =
    when === PLAN_CHANGE_IMMEDIATE
      ? previewImmediate.appliesNow
      : `Los cambios aplican el ${formatEffectDate(periodEndIso)}. Mantienes acceso completo a tu plan actual hasta entonces.`;

  const activePreview = when === PLAN_CHANGE_IMMEDIATE ? previewImmediate : previewEndOfPeriod;
  const previewFlags = resolvePlanChangePreviewFlags({ billingStrategy, when });

  return {
    allowed: true,
    allowedWhen: [PLAN_CHANGE_IMMEDIATE, PLAN_CHANGE_END_OF_PERIOD],
    rejectedWhen: [],
    changeType,
    effectiveDate: when === PLAN_CHANGE_IMMEDIATE ? new Date().toISOString() : periodEndIso,
    effectMessage,
    preview: activePreview,
    previews: {
      immediate: previewImmediate,
      end_of_period: previewEndOfPeriod,
    },
    recommendedWhen,
    requiresCheckout: previewFlags.requiresCheckout,
    requiresCheckoutForWhen: previewFlags.requiresCheckoutForWhen,
    schedulesInDbOnly: previewFlags.schedulesInDbOnly,
    billingStrategy,
    collectionMethodLabel: billingView.collectionMethodLabel,
    paymentProvider: billingView.paymentProvider,
    legacyPaymentProviderId: billingView.legacyPaymentProviderId,
    referralPlanChangeBlocked: isReferralCreditPeriodLocked(sub),
    referralForfeitRequired: creditsAvailableDays > 0,
    referralCreditsAvailableDays: creditsAvailableDays > 0 ? creditsAvailableDays : undefined,
  };
}

module.exports = {
  previewChangePlan,
};
