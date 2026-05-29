/**
 * Proveedores de cobro soportados (orquestación in-house, fase 1: MP).
 */

const PAYMENT_PROVIDER_MP_PREAPPROVAL = 'mercadopago_preapproval';
const PAYMENT_PROVIDER_MP_CHECKOUT_PRO = 'mp_checkout_pro';

function parseEnabledProviders() {
  const raw = process.env.BILLING_PROVIDERS_ENABLED || 'mercadopago_preapproval,mp_checkout_pro';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getDefaultPaymentProvider(organization) {
  const enabled = parseEnabledProviders();
  if (enabled.includes(PAYMENT_PROVIDER_MP_PREAPPROVAL) && isChileBilling(organization)) {
    return PAYMENT_PROVIDER_MP_PREAPPROVAL;
  }
  if (enabled.includes(PAYMENT_PROVIDER_MP_CHECKOUT_PRO)) return PAYMENT_PROVIDER_MP_CHECKOUT_PRO;
  return enabled[0] || PAYMENT_PROVIDER_MP_PREAPPROVAL;
}

/** @deprecated use getDefaultPaymentProvider(org) */
function getDefaultPaymentProviderLegacy() {
  const def = (process.env.BILLING_DEFAULT_PROVIDER || PAYMENT_PROVIDER_MP_CHECKOUT_PRO).trim();
  const enabled = parseEnabledProviders();
  if (enabled.includes(def)) return def;
  return enabled[0] || PAYMENT_PROVIDER_MP_CHECKOUT_PRO;
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

function listBillingProvidersForApi(organization) {
  const enabled = parseEnabledProviders();
  const all = [
    {
      id: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      label: 'Mercado Pago (pago con tarjeta)',
      description:
        'Pago en mercadopago.cl en pesos (CLP). Acepta tarjetas chilenas e internacionales. Ideal si tu correo está en MP de otro país.',
      supportsInternationalCards: true,
      supportsAutoRecurring: false,
      requiresMercadoPagoChileEmail: false,
      recommended: false,
    },
    {
      id: PAYMENT_PROVIDER_MP_PREAPPROVAL,
      label: 'Mercado Pago (débito automático)',
      description:
        'Cobro mensual automático. Requiere cuenta mercadopago.cl y el mismo correo en el checkout.',
      supportsInternationalCards: false,
      supportsAutoRecurring: true,
      requiresMercadoPagoChileEmail: true,
      recommended: true,
    },
  ];
  let filtered = all.filter((p) => enabled.includes(p.id));
  if (!isChileBilling(organization)) {
    filtered = filtered.filter((p) => p.id === PAYMENT_PROVIDER_MP_CHECKOUT_PRO);
  }
  return filtered;
}

function normalizePaymentProvider(value) {
  const v = String(value || '').trim();
  if (v === PAYMENT_PROVIDER_MP_CHECKOUT_PRO) return PAYMENT_PROVIDER_MP_CHECKOUT_PRO;
  if (v === PAYMENT_PROVIDER_MP_PREAPPROVAL) return PAYMENT_PROVIDER_MP_PREAPPROVAL;
  return getDefaultPaymentProvider();
}

function isProviderEnabled(provider) {
  return parseEnabledProviders().includes(provider);
}

function listBillingProvidersForApiLegacy() {
  const enabled = parseEnabledProviders();
  const all = [
    {
      id: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      label: 'Mercado Pago (pago con tarjeta)',
      description:
        'Pago en mercadopago.cl en pesos (CLP). Acepta tarjetas chilenas e internacionales. Ideal si tu correo está en MP de otro país.',
      supportsInternationalCards: true,
      supportsAutoRecurring: false,
      requiresMercadoPagoChileEmail: false,
      recommended: true,
    },
    {
      id: PAYMENT_PROVIDER_MP_PREAPPROVAL,
      label: 'Mercado Pago (débito automático)',
      description:
        'Cobro mensual automático. Requiere cuenta mercadopago.cl y el mismo correo en el checkout.',
      supportsInternationalCards: false,
      supportsAutoRecurring: true,
      requiresMercadoPagoChileEmail: true,
      recommended: false,
    },
  ];
  return all.filter((p) => enabled.includes(p.id));
}

/** external_reference: orgId|planSKU|cp|checkoutSessionId */
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
  parseEnabledProviders,
  getDefaultPaymentProvider,
  getDefaultPaymentProviderLegacy,
  resolveBillingCountry,
  isChileBilling,
  normalizePaymentProvider,
  isProviderEnabled,
  listBillingProvidersForApi,
  listBillingProvidersForApiLegacy,
  CHECKOUT_PRO_REF_TAG,
  buildCheckoutProExternalReference,
  parseExternalReference,
};
