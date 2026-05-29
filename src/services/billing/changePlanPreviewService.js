'use strict';

const prisma = require('../../lib/prisma');
const { getActiveSubscription } = require('../subscriptionService');
const { computePeriodEnd } = require('../../lib/billingPeriod');
const { priceWithIva } = require('./billingOverviewService');
const {
  PAYMENT_PROVIDER_MP_PREAPPROVAL,
  PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
} = require('../../lib/billingProviders');

const END_OF_PERIOD_REJECT_REASON =
  'Para programar un cambio al fin del periodo necesitas débito automático Mercado Pago. Actualiza tu método de pago.';

function formatEffectDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return String(isoDate).slice(0, 10);
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function orgCanUsePlan(organizationId, plan) {
  if (plan.isDefault) return true;
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { customPlanId: true },
  });
  if (org?.customPlanId === plan.id) return true;
  const offer = await prisma.customPlanOffer.findUnique({
    where: { planId_organizationId: { planId: plan.id, organizationId } },
  });
  return !!offer;
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

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.planSKU
 * @param {string} [params.when] end_of_period (único permitido para cambios activos)
 * @param {string} [params.paymentProvider]
 */
async function previewChangePlan({ organizationId, planSKU, when = 'end_of_period', paymentProvider }) {
  const sub = await getActiveSubscription(organizationId);
  if (!sub || sub.status !== 'active') {
    return {
      allowed: false,
      error: 'Solo puedes cambiar de plan con una suscripción activa.',
    };
  }

  const newPlan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!newPlan) {
    return { allowed: false, error: `Plan no encontrado: ${planSKU}` };
  }
  if (newPlan.comingSoon) {
    return { allowed: false, error: 'Este plan aún no está disponible.' };
  }
  if (!(await orgCanUsePlan(organizationId, newPlan))) {
    return { allowed: false, error: 'Este plan no está disponible para tu cuenta.' };
  }
  if (sub.plan?.productSKU === planSKU || sub.planId === newPlan.id) {
    return { allowed: false, error: 'Ya tienes este plan activo.' };
  }

  const currentPlan =
    sub.plan ||
    (await prisma.plan.findUnique({ where: { id: sub.planId } }));
  const currentPrice = priceWithIva(currentPlan?.priceCLP ?? 0);
  const newPrice = priceWithIva(newPlan.priceCLP);
  const periodEnd = sub.currentPeriodEnd ?? computePeriodEnd(sub.startDate, currentPlan);
  const periodEndIso = periodEnd.toISOString();
  const effectiveDate = periodEndIso.slice(0, 10);

  const rejectedWhen = [];
  if (when === 'now') {
    rejectedWhen.push({
      when: 'now',
      reason: 'Los cambios de plan se programan al fin del periodo actual.',
    });
  }

  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO) {
    rejectedWhen.push({
      when: 'end_of_period',
      reason: END_OF_PERIOD_REJECT_REASON,
    });
  }

  const isUpgrade = Number(newPlan.priceCLP) > Number(currentPlan?.priceCLP ?? 0);
  const changeType = isUpgrade ? 'upgrade' : 'downgrade';
  const { gained, lost } = diffFeatures(currentPlan, newPlan);

  const previewEndOfPeriod = {
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
    appliesLater: `El ${effectiveDate} cambias a ${newPlan.name}.`,
  };

  const effectMessage = `Los cambios aplican el ${formatEffectDate(periodEndIso)}. Mantienes acceso completo a tu plan actual hasta entonces.`;

  const blockedEndOfPeriod = paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO;
  const allowed = !blockedEndOfPeriod;

  return {
    allowed,
    allowedWhen: ['end_of_period'],
    rejectedWhen,
    changeType,
    effectiveDate: periodEndIso,
    effectMessage,
    preview: previewEndOfPeriod,
    previews: {
      end_of_period: previewEndOfPeriod,
    },
    recommendedWhen: 'end_of_period',
    requiresPreapprovalForScheduled: true,
    error: !allowed && rejectedWhen.length > 0 ? rejectedWhen[0].reason : undefined,
  };
}

module.exports = {
  previewChangePlan,
  END_OF_PERIOD_REJECT_REASON,
};
