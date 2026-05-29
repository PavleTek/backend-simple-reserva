/**
 * Proveedores de cobro: estrategia (cómo cobrar) + PSP + compat legacy MP.
 */

const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PAYMENT_PROVIDER_MERCADOPAGO,
  LEGACY_MP_PREAPPROVAL,
  LEGACY_MP_CHECKOUT_PRO,
  isLegacyProviderId,
  legacyIdFromStrategy,
  strategyFromLegacyProvider,
  normalizeBillingStrategy,
  normalizePaymentProviderPsp,
  collectionMethodLabel,
  subscriptionBillingView,
} = require('./billingDomain');

const PAYMENT_PROVIDER_MP_PREAPPROVAL = LEGACY_MP_PREAPPROVAL;
const PAYMENT_PROVIDER_MP_CHECKOUT_PRO = LEGACY_MP_CHECKOUT_PRO;

function parseEnabledStrategies() {
  const raw = process.env.BILLING_STRATEGIES_ENABLED || 'automatic_recurring,manual_monthly';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @deprecated use parseEnabledStrategies */
function parseEnabledProviders() {
  const raw = process.env.BILLING_PROVIDERS_ENABLED || 'mercadopago_preapproval,mp_checkout_pro';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getDefaultBillingStrategy(organization) {
  const enabled = parseEnabledStrategies();
  const legacyEnabled = parseEnabledProviders();
  if (
    enabled.includes(BILLING_STRATEGY_AUTOMATIC) &&
    legacyEnabled.includes(PAYMENT_PROVIDER_MP_PREAPPROVAL) &&
    isChileBilling(organization)
  ) {
    return BILLING_STRATEGY_AUTOMATIC;
  }
  if (enabled.includes(BILLING_STRATEGY_MANUAL) || legacyEnabled.includes(PAYMENT_PROVIDER_MP_CHECKOUT_PRO)) {
    return BILLING_STRATEGY_MANUAL;
  }
  return enabled[0] === BILLING_STRATEGY_MANUAL ? BILLING_STRATEGY_MANUAL : BILLING_STRATEGY_AUTOMATIC;
}

function getDefaultPaymentProvider(organization) {
  return legacyIdFromStrategy(getDefaultBillingStrategy(organization));
}

function resolveBillingCountry(organization) {
  if (!organization) return 'CL';
  const billingCountry = (organization.billingCountry || '').trim().toUpperCase();
  if (billingCountry) return billingCountry;
  const ownerCountry = (organization.owner?.country || organization.ownerCountry || '').trim().toUpperCase();
  if (ownerCountry) return ownerCountry;
  return 'CL';
}

function isChileBilling(organization) {
  return resolveBillingCountry(organization) === 'CL';
}

function listCollectionMethodsForApi(organization) {
  const enabled = parseEnabledStrategies();
  const legacyEnabled = parseEnabledProviders();
  const all = [
    {
      id: BILLING_STRATEGY_MANUAL,
      billingStrategy: BILLING_STRATEGY_MANUAL,
      paymentProvider: PAYMENT_PROVIDER_MERCADOPAGO,
      legacyId: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      label: 'Pago mensual manual',
      description:
        'Recibes un link de pago cada mes. Debes pagar antes del vencimiento; si no pagas, entra período de gracia.',
      supportsInternationalCards: true,
      supportsAutoRecurring: false,
      requiresMercadoPagoChileEmail: false,
      recommended: false,
    },
    {
      id: BILLING_STRATEGY_AUTOMATIC,
      billingStrategy: BILLING_STRATEGY_AUTOMATIC,
      paymentProvider: PAYMENT_PROVIDER_MERCADOPAGO,
      legacyId: PAYMENT_PROVIDER_MP_PREAPPROVAL,
      label: 'Débito automático',
      description:
        'Cobro automático mensual y renovación automática. Requiere cuenta mercadopago.cl y el mismo correo en el checkout.',
      supportsInternationalCards: false,
      supportsAutoRecurring: true,
      requiresMercadoPagoChileEmail: true,
      recommended: true,
    },
  ];
  let filtered = all.filter((p) => {
    const strategyOk = enabled.includes(p.billingStrategy);
    const legacyOk = legacyEnabled.includes(p.legacyId);
    return strategyOk || legacyOk;
  });
  if (!isChileBilling(organization)) {
    filtered = filtered.filter((p) => p.billingStrategy === BILLING_STRATEGY_MANUAL);
  }
  return filtered;
}

/** @deprecated alias */
function listBillingProvidersForApi(organization) {
  return listCollectionMethodsForApi(organization).map((m) => ({
    id: m.legacyId,
    billingStrategy: m.billingStrategy,
    paymentProvider: m.paymentProvider,
    label: m.label,
    description: m.description,
    supportsInternationalCards: m.supportsInternationalCards,
    supportsAutoRecurring: m.supportsAutoRecurring,
    requiresMercadoPagoChileEmail: m.requiresMercadoPagoChileEmail,
    recommended: m.recommended,
  }));
}

function normalizePaymentProvider(value, organization) {
  const v = String(value || '').trim();
  if (v === BILLING_STRATEGY_MANUAL || v === BILLING_STRATEGY_AUTOMATIC) {
    return legacyIdFromStrategy(v);
  }
  if (v === PAYMENT_PROVIDER_MP_CHECKOUT_PRO || v === PAYMENT_PROVIDER_MP_PREAPPROVAL) {
    return v;
  }
  if (v === PAYMENT_PROVIDER_MERCADOPAGO) {
    return legacyIdFromStrategy(getDefaultBillingStrategy(organization));
  }
  return legacyIdFromStrategy(getDefaultBillingStrategy(organization));
}

function normalizeBillingInput(body, organization) {
  const rawStrategy = body?.billingStrategy ?? body?.collectionMethod;
  const rawProvider = body?.paymentProvider;
  let billingStrategy = null;
  if (rawStrategy) {
    billingStrategy = normalizeBillingStrategy(rawStrategy, organization);
  } else if (isLegacyProviderId(rawProvider)) {
    billingStrategy = strategyFromLegacyProvider(rawProvider);
  } else if (rawProvider === PAYMENT_PROVIDER_MERCADOPAGO && body?.billingStrategy) {
    billingStrategy = normalizeBillingStrategy(body.billingStrategy, organization);
  } else if (isLegacyProviderId(rawProvider) || rawProvider) {
    billingStrategy = strategyFromLegacyProvider(normalizePaymentProvider(rawProvider, organization));
  } else {
    billingStrategy = getDefaultBillingStrategy(organization);
  }
  const psp = normalizePaymentProviderPsp(body?.paymentProviderPsp ?? PAYMENT_PROVIDER_MERCADOPAGO);
  return {
    billingStrategy,
    paymentProvider: psp,
    legacyPaymentProviderId: legacyIdFromStrategy(billingStrategy),
  };
}

function isStrategyEnabled(billingStrategy) {
  return parseEnabledStrategies().includes(billingStrategy);
}

function isProviderEnabled(legacyProviderId) {
  return parseEnabledProviders().includes(legacyProviderId);
}

const CHECKOUT_PRO_REF_TAG = 'cp';

function buildCheckoutProExternalReference(organizationId, planSKU, checkoutSessionId) {
  return `${organizationId}|${planSKU}|${CHECKOUT_PRO_REF_TAG}|${checkoutSessionId}`;
}

function parseExternalReference(externalRef) {
  const parts = String(externalRef || '').split('|');
  if (parts.length >= 4 && parts[2] === CHECKOUT_PRO_REF_TAG) {
    return {
      kind: 'checkout_pro',
      organizationId: parts[0],
      planSKU: parts[1] || 'plan-profesional',
      checkoutSessionId: parts[3],
    };
  }
  if (parts.length >= 2) {
    return {
      kind: 'legacy',
      organizationId: parts[0],
      planSKU: parts[1] || 'plan-profesional',
      checkoutSessionId: null,
    };
  }
  return null;
}

module.exports = {
  PAYMENT_PROVIDER_MP_PREAPPROVAL,
  PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PAYMENT_PROVIDER_MERCADOPAGO,
  parseEnabledProviders,
  parseEnabledStrategies,
  getDefaultBillingStrategy,
  getDefaultPaymentProvider,
  resolveBillingCountry,
  isChileBilling,
  normalizePaymentProvider,
  normalizeBillingInput,
  isStrategyEnabled,
  isProviderEnabled,
  listCollectionMethodsForApi,
  listBillingProvidersForApi,
  collectionMethodLabel,
  subscriptionBillingView,
  CHECKOUT_PRO_REF_TAG,
  buildCheckoutProExternalReference,
  parseExternalReference,
};
