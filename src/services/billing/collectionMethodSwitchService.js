'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  resolveBillingStrategy,
  checkoutSessionBillingData,
} = require('../../lib/billingDomain');
const {
  cancelSubscription,
  isPreapprovalAlreadyCancelledError,
} = require('../mercadopagoService');

/**
 * Débito automático → pago manual: cancela preapproval en MP y actualiza la sub activa (sin checkout).
 */
async function switchAutomaticToManualMonthly({ organizationId, subscriptionId }) {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, mercadopagoPreapprovalId: true, organizationId: true },
  });
  if (!sub || sub.organizationId !== organizationId) {
    const err = new Error('Suscripción no válida.');
    err.statusCode = 400;
    throw err;
  }

  const preapprovalId = sub.mercadopagoPreapprovalId;
  if (preapprovalId) {
    try {
      await cancelSubscription(preapprovalId);
    } catch (err) {
      if (!isPreapprovalAlreadyCancelledError(err)) {
        console.error('[collectionMethodSwitch] cancel preapproval:', err?.message ?? err);
        const e = new Error(
          'No pudimos desactivar el débito automático en Mercado Pago. Intenta nuevamente o contacta a soporte.',
        );
        e.statusCode = 502;
        throw e;
      }
    }
  }

  const billingFields = checkoutSessionBillingData({
    billingStrategy: BILLING_STRATEGY_MANUAL,
    paymentProvider: 'mercadopago',
  });

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      billingStrategy: billingFields.billingStrategy,
      paymentProvider: billingFields.paymentProvider,
      providerImplementation: billingFields.providerImplementation,
      mercadopagoPreapprovalId: null,
    },
  });

  planService.invalidateCache(organizationId);

  return {
    updated: true,
    requiresCheckout: false,
    billingStrategy: BILLING_STRATEGY_MANUAL,
    message:
      'Tu plan sigue activo. Pasaste a pago mensual manual: te enviaremos un link antes de cada renovación.',
  };
}

/**
 * @param {object} sub — suscripción activa con plan
 * @param {string} targetBillingStrategy
 */
function resolveCollectionMethodChange(sub, targetBillingStrategy) {
  const current = resolveBillingStrategy(sub);
  const target = targetBillingStrategy === BILLING_STRATEGY_MANUAL
    ? BILLING_STRATEGY_MANUAL
    : BILLING_STRATEGY_AUTOMATIC;

  if (current === target) {
    return { kind: 'noop', current, target };
  }
  if (current === BILLING_STRATEGY_AUTOMATIC && target === BILLING_STRATEGY_MANUAL) {
    return { kind: 'automatic_to_manual', current, target };
  }
  if (current === BILLING_STRATEGY_MANUAL && target === BILLING_STRATEGY_AUTOMATIC) {
    return { kind: 'manual_to_automatic', current, target };
  }
  return { kind: 'checkout', current, target };
}

module.exports = {
  switchAutomaticToManualMonthly,
  resolveCollectionMethodChange,
};
