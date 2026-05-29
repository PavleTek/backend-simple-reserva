'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const referralService = require('../referralService');
const mercadopagoAdapter = require('./adapters/mercadopagoBillingAdapter');
const {
  checkoutSessionBillingData,
  BILLING_STRATEGY_MANUAL,
  BILLING_STRATEGY_AUTOMATIC,
  resolveBillingStrategy,
} = require('../../lib/billingDomain');
const { PAYMENT_PROVIDER_MP_CHECKOUT_PRO, PAYMENT_PROVIDER_MP_PREAPPROVAL } = require('../../lib/billingProviders');
const { computePeriodEnd } = require('../../lib/billingPeriod');
const {
  cancelSubscription,
  isPreapprovalAlreadyCancelledError,
} = require('../mercadopagoService');

/**
 * @param {object|null|undefined} sub
 * @param {Date} [now]
 */
function isInReferralFreeWindow(sub, now = new Date()) {
  if (!sub?.referralFreeUntil) return false;
  return new Date(sub.referralFreeUntil) > now;
}

/**
 * Preview de créditos disponibles para ventana gratis.
 */
async function previewReferralFreeWindow(organizationId) {
  const totalDays = await referralService.getAvailableCreditDays(organizationId);
  if (totalDays <= 0) return null;
  const freeUntil = referralService.addDays(new Date(), totalDays);
  return { totalDays, freeUntil };
}

/**
 * Reserva créditos y difiere preapproval al fin de la ventana (débito automático).
 */
async function prepareAutomaticReferralCheckout(organizationId, createSubscriptionOptions, checkoutSessionId) {
  const totalDays = await referralService.getAvailableCreditDays(organizationId);
  if (totalDays <= 0) return null;

  const base = createSubscriptionOptions.startDate
    ? new Date(createSubscriptionOptions.startDate)
    : new Date();
  const creditResult = await referralService.applyAvailableCreditsOnNextCheckout(
    organizationId,
    base,
    checkoutSessionId,
  );
  if (creditResult.startDate) {
    createSubscriptionOptions.startDate = creditResult.startDate;
  }

  return {
    totalDays: creditResult.totalDays,
    freeUntil: creditResult.startDate,
    creditIds: creditResult.creditIds,
  };
}

/**
 * Detecta si un preapproval autorizado corresponde a ventana de días gratis (créditos reservados en checkout).
 */
async function isReferralFreeWindowPreapproval(organizationId, preapprovalId) {
  const session = await prisma.checkoutSession.findFirst({
    where: { organizationId, mercadopagoPreapprovalId: preapprovalId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, pendingChangeFromSubscriptionId: true },
  });
  if (!session) return false;

  const pendingKey = `checkout:${session.id}`;
  const creditCount = await prisma.referralCredit.count({
    where: {
      organizationId,
      status: 'applied',
      appliedToSubscriptionId: pendingKey,
    },
  });
  if (creditCount > 0) return true;

  if (session.pendingChangeFromSubscriptionId) {
    const parentSub = await prisma.subscription.findUnique({
      where: { id: session.pendingChangeFromSubscriptionId },
      select: { referralFreeUntil: true },
    });
    if (isInReferralFreeWindow(parentSub)) return true;
  }

  return false;
}

/**
 * Otorga ventana de acceso gratis sin pasar por Mercado Pago (pago manual).
 */
async function grantManualReferralFreeWindow({
  organizationId,
  plan,
  replaceSubscriptionId = null,
}) {
  const preview = await previewReferralFreeWindow(organizationId);
  if (!preview) return null;

  const billingFields = checkoutSessionBillingData({
    billingStrategy: BILLING_STRATEGY_MANUAL,
    paymentProvider: 'mercadopago',
  });

  const activatedAt = new Date();
  const freeUntil = preview.freeUntil;
  let subscriptionId;

  await prisma.$transaction(async (tx) => {
    if (replaceSubscriptionId) {
      const oldSub = await tx.subscription.findUnique({
        where: { id: replaceSubscriptionId },
        select: { organizationId: true, mercadopagoPreapprovalId: true },
      });
      if (!oldSub || oldSub.organizationId !== organizationId) {
        throw new Error('Suscripción previa no válida para esta organización');
      }
      if (oldSub.mercadopagoPreapprovalId) {
        try {
          await cancelSubscription(oldSub.mercadopagoPreapprovalId);
        } catch (err) {
          if (!isPreapprovalAlreadyCancelledError(err)) throw err;
        }
      }
    }

    await tx.subscription.updateMany({
      where: { organizationId, status: { in: ['trial', 'active', 'scheduled', 'grace', 'cancelled'] } },
      data: { status: 'cancelled', isActiveSubscription: false },
    });

    const created = await tx.subscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: 'active',
        isActiveSubscription: true,
        billingStrategy: billingFields.billingStrategy,
        paymentProvider: billingFields.paymentProvider,
        providerImplementation: billingFields.providerImplementation,
        startDate: activatedAt,
        currentPeriodEnd: freeUntil,
        referralFreeUntil: freeUntil,
      },
    });
    subscriptionId = created.id;

    await referralService.consumeCreditsForSubscription({
      organizationId,
      subscriptionId,
      tx,
    });

    await tx.restaurantOrganization.update({
      where: { id: organizationId },
      data: { trialEndsAt: null, planId: plan.id },
    });
  });

  planService.invalidateCache(organizationId);

  return {
    subscriptionId,
    totalDays: preview.totalDays,
    freeUntil,
    message: `Tienes ${preview.totalDays} días gratis. Te enviaremos el link de pago antes de que terminen.`,
  };
}

/**
 * Intenta otorgar ventana manual antes de crear checkout (pago mensual manual + créditos).
 */
async function tryGrantManualReferralWindowAtCheckout({ organizationId, planSKU, paymentProvider, replaceSubscriptionId }) {
  if (paymentProvider !== PAYMENT_PROVIDER_MP_CHECKOUT_PRO) return null;

  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) return null;

  return grantManualReferralFreeWindow({ organizationId, plan, replaceSubscriptionId });
}

/**
 * Limpia ventana tras primer cobro real y avanza el periodo de facturación.
 */
async function clearReferralFreeWindowOnFirstPayment(sub, plan) {
  if (!sub?.referralFreeUntil) return false;

  const now = new Date();
  const nextPeriodEnd = computePeriodEnd(now, plan);

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      referralFreeUntil: null,
      currentPeriodEnd: nextPeriodEnd,
      status: 'active',
      isActiveSubscription: true,
      gracePeriodEndsAt: null,
    },
  });

  planService.invalidateCache(sub.organizationId);
  return true;
}

/**
 * Cambio de plan durante ventana activa: conserva referralFreeUntil / currentPeriodEnd.
 */
async function changePlanInReferralFreeWindow({
  organizationId,
  userId,
  payerEmail,
  restaurantId,
  currentSub,
  newPlan,
  whenNorm,
}) {
  const freeUntil = new Date(currentSub.referralFreeUntil);
  const billingStrategy = resolveBillingStrategy(currentSub);

  if (billingStrategy === BILLING_STRATEGY_MANUAL) {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: currentSub.id },
        data: {
          planId: newPlan.id,
          scheduledPlanId: null,
          scheduledChangeAt: null,
          planChangeWhen: null,
        },
      });
      await tx.restaurantOrganization.update({
        where: { id: organizationId },
        data: { planId: newPlan.id },
      });
    });

    planService.invalidateCache(organizationId);

    const endLabel = freeUntil.toLocaleDateString('es-CL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    return {
      scheduled: false,
      requiresCheckout: false,
      planChanged: true,
      referralFreeUntil: freeUntil.toISOString(),
      message: `Cambiaste al plan ${newPlan.name}. Tus días gratis se mantienen hasta el ${endLabel}.`,
    };
  }

  if (currentSub.mercadopagoPreapprovalId) {
    try {
      await cancelSubscription(currentSub.mercadopagoPreapprovalId);
    } catch (err) {
      if (!isPreapprovalAlreadyCancelledError(err)) {
        const e = new Error(
          'No pudimos actualizar el débito automático en Mercado Pago. Intenta nuevamente o contacta a soporte.',
        );
        e.statusCode = 502;
        throw e;
      }
    }
  }

  await prisma.checkoutSession.updateMany({
    where: { organizationId, status: 'pending' },
    data: { status: 'expired' },
  });

  const result = await mercadopagoAdapter.createCheckout({
    organizationId,
    userId,
    payerEmail,
    planSKU: newPlan.productSKU,
    restaurantId,
    when: 'now',
    billingStrategy: BILLING_STRATEGY_AUTOMATIC,
    pendingChangeFromSubscriptionId: currentSub.id,
    createSubscriptionOptions: { startDate: freeUntil },
  });

  await prisma.subscription.update({
    where: { id: currentSub.id },
    data: { planChangeWhen: whenNorm },
  });

  planService.invalidateCache(organizationId);

  return {
    scheduled: false,
    checkoutUrl: result.checkoutUrl,
    providerId: result.providerId,
    billingStrategy: BILLING_STRATEGY_AUTOMATIC,
    checkoutHints: result.checkoutHints,
    requiresCheckout: true,
    referralFreeUntil: freeUntil.toISOString(),
  };
}

/**
 * startDate para manual→automatic cuando hay ventana activa.
 */
function deferredStartDateForCollectionSwitch(sub) {
  if (!isInReferralFreeWindow(sub)) return null;
  return new Date(sub.referralFreeUntil);
}

module.exports = {
  isInReferralFreeWindow,
  previewReferralFreeWindow,
  prepareAutomaticReferralCheckout,
  isReferralFreeWindowPreapproval,
  grantManualReferralFreeWindow,
  tryGrantManualReferralWindowAtCheckout,
  clearReferralFreeWindowOnFirstPayment,
  changePlanInReferralFreeWindow,
  deferredStartDateForCollectionSwitch,
  PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
  PAYMENT_PROVIDER_MP_PREAPPROVAL,
};
