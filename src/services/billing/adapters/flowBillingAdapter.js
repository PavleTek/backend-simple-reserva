'use strict';

const prisma = require('../../../lib/prisma');
const flowService = require('../../flowService');
const { PAYMENT_PROVIDER_FLOW } = require('../../../lib/billingDomain');

/**
 * Flow checkout: card enrollment redirect, or subscribe in-place if a card is on file.
 */
async function createCheckout({
  organizationId,
  userId,
  planSKU,
  restaurantId,
  when = 'now',
  pendingChangeFromSubscriptionId,
  createSubscriptionOptions = {},
}) {
  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) {
    const err = new Error('Plan no encontrado.');
    err.statusCode = 400;
    throw err;
  }

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: {
      flowCardLast4: true,
      flowCardRegisteredAt: true,
      flowCustomerId: true,
    },
  });

  const pending = await prisma.checkoutSession.findFirst({
    where: {
      organizationId,
      planId: plan.id,
      status: 'pending',
      expiresAt: { gt: new Date() },
      paymentProvider: PAYMENT_PROVIDER_FLOW,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (pending?.checkoutUrl && !flowService.hasEnrolledCard(org)) {
    return { checkoutUrl: pending.checkoutUrl, providerId: PAYMENT_PROVIDER_FLOW };
  }

  const periodEnd = createSubscriptionOptions.startDate || null;
  const scheduledStartAt = when === 'end_of_period' || when === 'end_of_trial' ? periodEnd : null;

  const subscribe = () => flowService.subscribeWithEnrolledCard({
    organizationId,
    userId,
    plan,
    restaurantId,
    pendingChangeFromSubscriptionId,
    when,
    periodEnd,
    trialEndsAt: when === 'end_of_trial' ? periodEnd : null,
    referralFreeUntil: createSubscriptionOptions.referralFreeUntil || null,
  });

  if (flowService.hasEnrolledCard(org)) {
    return subscribe();
  }

  const enrollment = await flowService.startCardEnrollmentCheckout({
    organizationId,
    userId,
    plan,
    restaurantId,
    pendingChangeFromSubscriptionId,
    scheduledStartAt,
  });
  if (!enrollment) return subscribe();
  return { checkoutUrl: enrollment.checkoutUrl, providerId: PAYMENT_PROVIDER_FLOW };
}

function flowConfigError(error) {
  return /FLOW_API_KEY|FLOW_SECRET_KEY|no configurad/i.test(error?.message || '');
}

module.exports = {
  createCheckout,
  flowConfigError,
};
