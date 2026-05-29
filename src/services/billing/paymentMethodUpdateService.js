'use strict';

const prisma = require('../../lib/prisma');
const { getActiveSubscription } = require('../subscriptionService');
const { canSelfServeBillingOrThrow } = require('../../lib/canSelfServeBilling');
const { resolvePlanOfferFlags } = require('../../lib/planSource');
const billingCheckoutService = require('../billingCheckoutService');

/**
 * Inicia checkout para cambiar método de pago sin cambiar plan.
 */
async function updatePaymentMethod({
  organizationId,
  userId,
  restaurantId,
  paymentProvider,
  payerEmail,
  loginEmail,
}) {
  const sub = await getActiveSubscription(organizationId);
  canSelfServeBillingOrThrow(sub);
  if (!sub || sub.status !== 'active') {
    const err = new Error('Activa un plan de pago antes de cambiar el método de cobro.');
    err.statusCode = 400;
    throw err;
  }

  const plan = sub.plan || (await prisma.plan.findUnique({ where: { id: sub.planId } }));
  if (plan?.id) {
    const flags = await resolvePlanOfferFlags(organizationId, plan.id);
    if (!flags.selfServiceBillingStrategyChanges) {
      const err = new Error('El método de cobro de tu plan está gestionado por SimpleReserva. Contacta a soporte.');
      err.statusCode = 403;
      throw err;
    }
  }
  if (!plan) {
    const err = new Error('Plan no encontrado.');
    err.statusCode = 400;
    throw err;
  }

  return billingCheckoutService.createBillingCheckoutWithPendingChange({
    organizationId,
    userId,
    payerEmail: payerEmail || loginEmail,
    planSKU: plan.productSKU,
    restaurantId,
    when: 'now',
    paymentProvider,
    pendingChangeFromSubscriptionId: sub.id,
    createSubscriptionOptions: {},
  });
}

module.exports = {
  updatePaymentMethod,
};
