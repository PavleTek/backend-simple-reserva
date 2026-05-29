'use strict';

const prisma = require('../../lib/prisma');
const { getActiveSubscription } = require('../subscriptionService');
const mercadopagoCheckoutProService = require('../mercadopagoCheckoutProService');
const { buildCheckoutProExternalReferenceV2 } = require('../../lib/externalReferenceV2');
const { priceWithIva } = require('./billingOverviewService');

/**
 * Genera link Checkout Pro para recuperar periodo en mora (grace).
 */
async function createRecoveryPaymentLink({ organizationId, userId, restaurantId }) {
  const sub = await getActiveSubscription(organizationId);
  if (!sub || sub.status !== 'grace') {
    const err = new Error('Solo puedes pagar ahora si tienes un cobro pendiente en periodo de gracia.');
    err.statusCode = 400;
    throw err;
  }

  const plan = sub.plan || (await prisma.plan.findUnique({ where: { id: sub.planId } }));
  if (!plan) {
    const err = new Error('Plan no encontrado.');
    err.statusCode = 400;
    throw err;
  }

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { billingEmail: true, name: true },
  });

  const session = await prisma.checkoutSession.create({
    data: {
      organizationId,
      userId,
      planId: plan.id,
      status: 'pending',
      paymentProvider: 'mp_checkout_pro',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const externalRef = buildCheckoutProExternalReferenceV2({
    organizationId,
    planSKU: plan.productSKU,
    provider: 'mp_checkout_pro',
    purpose: 'recovery',
    sessionId: session.id,
  });

  const { checkoutUrl, preferenceId } = await mercadopagoCheckoutProService.createRecoveryPreference({
    organizationId,
    payerEmail: org?.billingEmail,
    plan,
    restaurantId,
    checkoutSessionId: session.id,
    externalReference: externalRef,
    subscriptionId: sub.id,
  });

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      checkoutUrl,
      mercadopagoPreferenceId: preferenceId,
    },
  });

  const amount = priceWithIva(plan.priceCLP);

  return {
    paymentUrl: checkoutUrl,
    sessionId: session.id,
    amountWithIVA: amount.withIva,
    currency: 'CLP',
    gracePeriodEndsAt: sub.gracePeriodEndsAt?.toISOString?.() ?? null,
  };
}

module.exports = {
  createRecoveryPaymentLink,
};
