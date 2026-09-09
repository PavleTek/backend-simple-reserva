'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYMENT_PROVIDER_FLOW,
  PROVIDER_IMPL_FLOW_SUBSCRIPTION,
  FLOW_COLLECTION_METHOD_LABEL,
  normalizePaymentProviderPsp,
  resolvePaymentProviderPsp,
  resolveProviderImplementation,
  checkoutSessionBillingData,
  subscriptionBillingView,
  collectionMethodLabel,
} = require('./billingDomain');

describe('billingDomain flow PSP', () => {
  it('normalizes flow psp', () => {
    assert.equal(normalizePaymentProviderPsp('flow'), PAYMENT_PROVIDER_FLOW);
    assert.equal(resolvePaymentProviderPsp({ paymentProvider: 'flow' }), PAYMENT_PROVIDER_FLOW);
  });

  it('resolves flow_subscription implementation', () => {
    assert.equal(
      resolveProviderImplementation({ paymentProvider: 'flow' }),
      PROVIDER_IMPL_FLOW_SUBSCRIPTION,
    );
    const session = checkoutSessionBillingData({
      billingStrategy: 'automatic_recurring',
      paymentProvider: 'flow',
    });
    assert.equal(session.paymentProvider, PAYMENT_PROVIDER_FLOW);
    assert.equal(session.providerImplementation, PROVIDER_IMPL_FLOW_SUBSCRIPTION);
  });

  it('labels Flow collection method', () => {
    assert.equal(collectionMethodLabel('automatic_recurring', 'flow'), FLOW_COLLECTION_METHOD_LABEL);
    const view = subscriptionBillingView({
      billingStrategy: 'automatic_recurring',
      paymentProvider: 'flow',
      providerImplementation: 'flow_subscription',
    });
    assert.equal(view.collectionMethodLabel, FLOW_COLLECTION_METHOD_LABEL);
    assert.equal(view.paymentProvider, PAYMENT_PROVIDER_FLOW);
  });
});
