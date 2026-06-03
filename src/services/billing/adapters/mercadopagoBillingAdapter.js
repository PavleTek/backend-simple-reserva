'use strict';

const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  legacyIdFromStrategy,
} = require('../../../lib/billingDomain');
const billingCheckoutService = require('../../billingCheckoutService');

/**
 * Adaptador Mercado Pago: traduce billingStrategy → API interna (preapproval | checkout_pro).
 */
async function createCheckout({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  when,
  billingStrategy,
  pendingChangeFromSubscriptionId,
  createSubscriptionOptions = {},
}) {
  const legacyProvider = legacyIdFromStrategy(billingStrategy);

  if (pendingChangeFromSubscriptionId) {
    return billingCheckoutService.createBillingCheckoutWithPendingChange({
      organizationId,
      userId,
      payerEmail,
      planSKU,
      restaurantId,
      when,
      paymentProvider: legacyProvider,
      pendingChangeFromSubscriptionId,
      createSubscriptionOptions,
    });
  }

  return billingCheckoutService.createBillingCheckout({
    organizationId,
    userId,
    payerEmail,
    planSKU,
    restaurantId,
    when,
    paymentProvider: legacyProvider,
    createSubscriptionOptions,
  });
}

function requiresPayerEmail(billingStrategy) {
  return billingStrategy === BILLING_STRATEGY_AUTOMATIC;
}

module.exports = {
  createCheckout,
  requiresPayerEmail,
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
};
