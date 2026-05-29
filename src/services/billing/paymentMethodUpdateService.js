'use strict';

const prisma = require('../../lib/prisma');
const { getActiveSubscription } = require('../subscriptionService');
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
  if (!sub || sub.status !== 'active') {
    const err = new Error('Solo puedes cambiar el método de pago con una suscripción activa.');
    err.statusCode = 400;
    throw err;
  }

  const plan = sub.plan || (await prisma.plan.findUnique({ where: { id: sub.planId } }));
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
