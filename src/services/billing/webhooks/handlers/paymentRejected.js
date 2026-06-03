'use strict';

const prisma = require('../../lib/prisma');
const { handleCheckoutPaymentRejected } = require('../billingEmailService');

/**
 * @param {Object} event
 */
module.exports = async function paymentRejectedHandler(event) {
  const organizationId = event.organizationId;
  if (!organizationId) {
    return { handled: true, reason: 'no_organization' };
  }

  const mpPayment = event.mpEntity;
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: {
      name: true,
      owner: { select: { email: true } },
    },
  });

  const activeSub = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });

  await handleCheckoutPaymentRejected({
    organizationId,
    subscriptionId: activeSub?.id,
    mpPayment,
    orgName: org?.name || organizationId,
    ownerEmail: org?.owner?.email,
  });

  return { handled: true };
};
