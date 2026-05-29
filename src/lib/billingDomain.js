'use strict';

/**
 * Dominio SaaS de facturación: Subscription (plan) + Billing Strategy + Payment Provider (PSP).
 * Los IDs legacy mercadopago_preapproval / mp_checkout_pro se mapean a strategy + implementation.
 */

const BILLING_STRATEGY_AUTOMATIC = 'automatic_recurring';
const BILLING_STRATEGY_MANUAL = 'manual_monthly';

const PAYMENT_PROVIDER_MERCADOPAGO = 'mercadopago';

const PROVIDER_IMPL_PREAPPROVAL = 'preapproval';
const PROVIDER_IMPL_CHECKOUT_PRO = 'checkout_pro';

/** Legacy — uso interno en adaptadores MP */
const LEGACY_MP_PREAPPROVAL = 'mercadopago_preapproval';
const LEGACY_MP_CHECKOUT_PRO = 'mp_checkout_pro';

const PLAN_CHANGE_IMMEDIATE = 'immediate';
const PLAN_CHANGE_END_OF_PERIOD = 'end_of_period';

const COLLECTION_METHOD_LABELS = {
  [BILLING_STRATEGY_AUTOMATIC]: 'Débito automático',
  [BILLING_STRATEGY_MANUAL]: 'Pago mensual manual',
};

function isLegacyProviderId(value) {
  const v = String(value || '').trim();
  return v === LEGACY_MP_PREAPPROVAL || v === LEGACY_MP_CHECKOUT_PRO;
}

function legacyIdFromStrategy(billingStrategy) {
  return billingStrategy === BILLING_STRATEGY_MANUAL
    ? LEGACY_MP_CHECKOUT_PRO
    : LEGACY_MP_PREAPPROVAL;
}

function strategyFromLegacyProvider(legacyId) {
  if (legacyId === LEGACY_MP_CHECKOUT_PRO) return BILLING_STRATEGY_MANUAL;
  return BILLING_STRATEGY_AUTOMATIC;
}

function implementationFromLegacyProvider(legacyId) {
  if (legacyId === LEGACY_MP_CHECKOUT_PRO) return PROVIDER_IMPL_CHECKOUT_PRO;
  return PROVIDER_IMPL_PREAPPROVAL;
}

/**
 * @param {object|null|undefined} subOrSession — fila Subscription / CheckoutSession o { billingStrategy, paymentProvider, providerImplementation }
 */
function resolveBillingStrategy(subOrSession) {
  if (!subOrSession) return BILLING_STRATEGY_AUTOMATIC;
  const explicit = String(subOrSession.billingStrategy || '').trim();
  if (explicit === BILLING_STRATEGY_MANUAL || explicit === BILLING_STRATEGY_AUTOMATIC) {
    return explicit;
  }
  if (isLegacyProviderId(subOrSession.paymentProvider)) {
    return strategyFromLegacyProvider(subOrSession.paymentProvider);
  }
  if (subOrSession.providerImplementation === PROVIDER_IMPL_CHECKOUT_PRO) {
    return BILLING_STRATEGY_MANUAL;
  }
  return BILLING_STRATEGY_AUTOMATIC;
}

function resolvePaymentProviderPsp(subOrSession) {
  if (!subOrSession) return PAYMENT_PROVIDER_MERCADOPAGO;
  const psp = String(subOrSession.paymentProvider || '').trim();
  if (psp === PAYMENT_PROVIDER_MERCADOPAGO || psp === 'paypal' || psp === 'stripe') {
    return psp;
  }
  if (isLegacyProviderId(psp)) return PAYMENT_PROVIDER_MERCADOPAGO;
  return PAYMENT_PROVIDER_MERCADOPAGO;
}

function resolveProviderImplementation(subOrSession) {
  if (!subOrSession) return PROVIDER_IMPL_PREAPPROVAL;
  const impl = String(subOrSession.providerImplementation || '').trim();
  if (impl === PROVIDER_IMPL_CHECKOUT_PRO || impl === PROVIDER_IMPL_PREAPPROVAL) {
    return impl;
  }
  if (isLegacyProviderId(subOrSession.paymentProvider)) {
    return implementationFromLegacyProvider(subOrSession.paymentProvider);
  }
  const strategy = resolveBillingStrategy(subOrSession);
  return strategy === BILLING_STRATEGY_MANUAL ? PROVIDER_IMPL_CHECKOUT_PRO : PROVIDER_IMPL_PREAPPROVAL;
}

/** ID legacy para servicios MP existentes */
function resolveLegacyPaymentProviderId(subOrSession) {
  return legacyIdFromStrategy(resolveBillingStrategy(subOrSession));
}

function normalizeBillingStrategy(value, organization) {
  const v = String(value || '').trim();
  if (v === BILLING_STRATEGY_MANUAL || v === BILLING_STRATEGY_AUTOMATIC) return v;
  if (v === LEGACY_MP_CHECKOUT_PRO) return BILLING_STRATEGY_MANUAL;
  if (v === LEGACY_MP_PREAPPROVAL) return BILLING_STRATEGY_AUTOMATIC;
  const { getDefaultBillingStrategy } = require('./billingProviders');
  return getDefaultBillingStrategy(organization);
}

function normalizePaymentProviderPsp(value) {
  const v = String(value || '').trim();
  if (v === PAYMENT_PROVIDER_MERCADOPAGO || v === 'paypal' || v === 'stripe') return v;
  if (isLegacyProviderId(v)) return PAYMENT_PROVIDER_MERCADOPAGO;
  return PAYMENT_PROVIDER_MERCADOPAGO;
}

function normalizePlanChangeWhen(value) {
  const v = String(value || '').trim();
  if (v === 'now' || v === PLAN_CHANGE_IMMEDIATE) return PLAN_CHANGE_IMMEDIATE;
  if (v === PLAN_CHANGE_END_OF_PERIOD) return PLAN_CHANGE_END_OF_PERIOD;
  return PLAN_CHANGE_END_OF_PERIOD;
}

function collectionMethodLabel(billingStrategy) {
  return COLLECTION_METHOD_LABELS[billingStrategy] || COLLECTION_METHOD_LABELS[BILLING_STRATEGY_AUTOMATIC];
}

function subscriptionBillingView(sub) {
  const billingStrategy = resolveBillingStrategy(sub);
  const paymentProvider = resolvePaymentProviderPsp(sub);
  return {
    billingStrategy,
    paymentProvider,
    providerImplementation: resolveProviderImplementation(sub),
    collectionMethodLabel: collectionMethodLabel(billingStrategy),
    isAutomatic: billingStrategy === BILLING_STRATEGY_AUTOMATIC,
    isManual: billingStrategy === BILLING_STRATEGY_MANUAL,
    /** @deprecated compat API — no usar en UI nueva */
    legacyPaymentProviderId: legacyIdFromStrategy(billingStrategy),
  };
}

function checkoutSessionBillingData({ billingStrategy, paymentProvider }) {
  const strategy = normalizeBillingStrategy(billingStrategy);
  const psp = normalizePaymentProviderPsp(paymentProvider);
  return {
    billingStrategy: strategy,
    paymentProvider: psp,
    providerImplementation:
      strategy === BILLING_STRATEGY_MANUAL ? PROVIDER_IMPL_CHECKOUT_PRO : PROVIDER_IMPL_PREAPPROVAL,
    legacyPaymentProviderId: legacyIdFromStrategy(strategy),
  };
}

module.exports = {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PAYMENT_PROVIDER_MERCADOPAGO,
  PROVIDER_IMPL_PREAPPROVAL,
  PROVIDER_IMPL_CHECKOUT_PRO,
  LEGACY_MP_PREAPPROVAL,
  LEGACY_MP_CHECKOUT_PRO,
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
  COLLECTION_METHOD_LABELS,
  isLegacyProviderId,
  legacyIdFromStrategy,
  strategyFromLegacyProvider,
  resolveBillingStrategy,
  resolvePaymentProviderPsp,
  resolveProviderImplementation,
  resolveLegacyPaymentProviderId,
  normalizeBillingStrategy,
  normalizePaymentProviderPsp,
  normalizePlanChangeWhen,
  collectionMethodLabel,
  subscriptionBillingView,
  checkoutSessionBillingData,
};
