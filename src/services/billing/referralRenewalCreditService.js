'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const referralService = require('../referralService');
const { getActiveSubscription } = require('../subscriptionService');
const { canSelfServeBilling } = require('../../lib/canSelfServeBilling');
const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  resolveBillingStrategy,
} = require('../../lib/billingDomain');
const mercadopagoAdapter = require('./adapters/mercadopagoBillingAdapter');
const {
  isInReferralFreeWindow,
  isReferralCreditExtensionScheduled,
  scheduledRenewalCreditDays,
} = require('./referralFreeWindowService');
const {
  cancelSubscription,
  isPreapprovalAlreadyCancelledError,
} = require('../mercadopagoService');

function formatEffectDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return String(isoDate).slice(0, 10);
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * @param {object|null} sub
 * @param {number} creditsAvailableDays
 */
function evaluateRenewalCreditEligibility(sub, creditsAvailableDays) {
  if (!sub || !sub.isActiveSubscription) {
    return { eligible: false, blockedReason: 'not_active' };
  }
  if (sub.status === 'cancelled_by_admin') {
    return { eligible: false, blockedReason: 'admin_comped' };
  }
  if (sub.status === 'grace') {
    return { eligible: false, blockedReason: 'grace' };
  }
  const gate = canSelfServeBilling(sub);
  if (!gate.allowed) {
    if (gate.code === 'cancelled_in_period') return { eligible: false, blockedReason: 'cancelled' };
    return { eligible: false, blockedReason: gate.code || 'not_active' };
  }
  if (sub.status !== 'active') {
    return { eligible: false, blockedReason: 'not_active' };
  }
  if (isInReferralFreeWindow(sub) || isReferralCreditExtensionScheduled(sub)) {
    return { eligible: false, blockedReason: 'in_free_window' };
  }
  if (sub.scheduledPlanId) {
    return { eligible: false, blockedReason: 'scheduled_change' };
  }
  if (!sub.currentPeriodEnd) {
    return { eligible: false, blockedReason: 'no_period_end' };
  }
  const periodEnd = new Date(sub.currentPeriodEnd);
  if (Number.isNaN(periodEnd.getTime()) || periodEnd <= new Date()) {
    return { eligible: false, blockedReason: 'no_period_end' };
  }
  if (creditsAvailableDays <= 0) {
    return { eligible: false, blockedReason: 'no_credits' };
  }
  return { eligible: true };
}

/**
 * @param {string} organizationId
 */
async function previewReferralCreditsOnRenewal(organizationId) {
  const sub = await getActiveSubscription(organizationId);
  const creditsAvailableDays = await referralService.getAvailableCreditDays(organizationId);
  const { eligible, blockedReason } = evaluateRenewalCreditEligibility(sub, creditsAvailableDays);

  if (!sub) {
    return { allowed: false, error: 'No tienes una suscripción activa.', code: 'no_subscription' };
  }

  const billingStrategy = resolveBillingStrategy(sub);
  const anchor = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const freeUntil = anchor && creditsAvailableDays > 0 ? referralService.addDays(anchor, creditsAvailableDays) : null;

  return {
    allowed: eligible,
    error: eligible ? null : blockedReasonToMessage(blockedReason),
    code: eligible ? null : blockedReason,
    totalDays: creditsAvailableDays,
    currentPeriodEnd: anchor?.toISOString() ?? null,
    newChargeDate: freeUntil?.toISOString() ?? null,
    requiresMpReauth: eligible && billingStrategy === BILLING_STRATEGY_AUTOMATIC,
    billingStrategy,
    blockedReason: eligible ? null : blockedReason,
  };
}

function blockedReasonToMessage(reason) {
  switch (reason) {
    case 'in_free_window':
      return 'Ya tienes días gratis de referido activos o programados.';
    case 'scheduled_change':
      return 'Cancela el cambio de plan programado antes de usar créditos en la renovación.';
    case 'grace':
      return 'Regulariza el cobro pendiente antes de usar créditos de referido.';
    case 'cancelled':
      return 'Reactiva tu suscripción para usar créditos de referido.';
    case 'no_credits':
      return 'No tienes créditos de referido disponibles.';
    case 'no_period_end':
      return 'No pudimos calcular tu próxima renovación. Contacta a soporte.';
    case 'admin_comped':
      return 'Tu plan está gestionado por SimpleReserva. Contacta a soporte.';
    default:
      return 'No puedes canjear créditos en la renovación en este momento.';
  }
}

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.userId
 * @param {string} params.payerEmail
 * @param {string} params.restaurantId
 */
async function applyReferralCreditsToNextRenewal({
  organizationId,
  userId,
  payerEmail,
  restaurantId,
}) {
  const sub = await getActiveSubscription(organizationId);
  if (!sub?.plan) {
    const err = new Error('No pudimos cargar tu plan actual.');
    err.statusCode = 400;
    throw err;
  }

  const creditsAvailableDays = await referralService.getAvailableCreditDays(organizationId);
  const { eligible, blockedReason } = evaluateRenewalCreditEligibility(sub, creditsAvailableDays);
  if (!eligible) {
    const err = new Error(blockedReasonToMessage(blockedReason));
    err.statusCode = 400;
    err.code = blockedReason;
    throw err;
  }

  const anchor = new Date(sub.currentPeriodEnd);
  const freeUntil = referralService.addDays(anchor, creditsAvailableDays);
  const billingStrategy = resolveBillingStrategy(sub);
  const endLabel = formatEffectDate(freeUntil.toISOString());
  const anchorLabel = formatEffectDate(anchor.toISOString());

  if (billingStrategy === BILLING_STRATEGY_MANUAL) {
    await prisma.$transaction(async (tx) => {
      await referralService.consumeCreditsForSubscription({
        organizationId,
        subscriptionId: sub.id,
        tx,
      });
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          referralFreeUntil: freeUntil,
          referralFreeWindowStartsAt: anchor,
          currentPeriodEnd: freeUntil,
        },
      });
    });

    planService.invalidateCache(organizationId);

    return {
      applied: true,
      requiresCheckout: false,
      totalDays: creditsAvailableDays,
      referralFreeUntil: freeUntil.toISOString(),
      referralFreeWindowStartsAt: anchor.toISOString(),
      newChargeDate: freeUntil.toISOString(),
      message: `Aplicaste ${creditsAvailableDays} días de referido. Tras tu periodo pagado (hasta el ${anchorLabel}), tendrás acceso gratis hasta el ${endLabel}. El próximo cobro será después de esa fecha.`,
    };
  }

  if (sub.mercadopagoPreapprovalId) {
    try {
      await cancelSubscription(sub.mercadopagoPreapprovalId);
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

  await prisma.$transaction(async (tx) => {
    await referralService.consumeCreditsForSubscription({
      organizationId,
      subscriptionId: sub.id,
      tx,
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        referralFreeUntil: freeUntil,
        referralFreeWindowStartsAt: anchor,
        currentPeriodEnd: freeUntil,
        mercadopagoPreapprovalId: null,
      },
    });
  });

  await prisma.checkoutSession.updateMany({
    where: { organizationId, status: 'pending' },
    data: { status: 'expired' },
  });

  const result = await mercadopagoAdapter.createCheckout({
    organizationId,
    userId,
    payerEmail,
    planSKU: sub.plan.productSKU,
    restaurantId,
    when: 'now',
    billingStrategy: BILLING_STRATEGY_AUTOMATIC,
    pendingChangeFromSubscriptionId: sub.id,
    createSubscriptionOptions: { startDate: freeUntil },
  });

  planService.invalidateCache(organizationId);

  return {
    applied: true,
    requiresCheckout: true,
    checkoutUrl: result.checkoutUrl,
    providerId: result.providerId,
    billingStrategy: BILLING_STRATEGY_AUTOMATIC,
    checkoutHints: result.checkoutHints,
    totalDays: creditsAvailableDays,
    referralFreeUntil: freeUntil.toISOString(),
    referralFreeWindowStartsAt: anchor.toISOString(),
    newChargeDate: freeUntil.toISOString(),
    message: `Crédito aplicado. Autoriza el débito automático en Mercado Pago; el primer cobro queda para el ${endLabel} (después de ${creditsAvailableDays} días gratis tras tu periodo pagado).`,
  };
}

module.exports = {
  evaluateRenewalCreditEligibility,
  previewReferralCreditsOnRenewal,
  applyReferralCreditsToNextRenewal,
  blockedReasonToMessage,
  isReferralCreditExtensionScheduled,
  scheduledRenewalCreditDays,
};
