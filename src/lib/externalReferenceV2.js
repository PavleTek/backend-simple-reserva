'use strict';

const REF_VERSION = 'v2';

/**
 * v2:{orgId}|{planSKU}|{provider}|{purpose}|{sessionId}
 */
function buildExternalReferenceV2({ organizationId, planSKU, provider, purpose, sessionId }) {
  return `${REF_VERSION}:${organizationId}|${planSKU}|${provider}|${purpose}|${sessionId}`;
}

function buildCheckoutProExternalReferenceV2({ organizationId, planSKU, provider, purpose, sessionId }) {
  return buildExternalReferenceV2({
    organizationId,
    planSKU,
    provider: provider || 'mp_checkout_pro',
    purpose: purpose || 'initial',
    sessionId,
  });
}

function buildPreapprovalExternalReferenceV2({ organizationId, planSKU, purpose, sessionId }) {
  return buildExternalReferenceV2({
    organizationId,
    planSKU,
    provider: 'mercadopago_preapproval',
    purpose: purpose || 'initial',
    sessionId: sessionId || 'none',
  });
}

/**
 * Parsea v2 y legacy (org|sku o org|sku|cp|session).
 * @returns {{ kind, organizationId, planSKU, provider?, purpose?, checkoutSessionId?, schemaVersion }}
 */
function parseExternalReferenceV2(externalRef) {
  const raw = String(externalRef || '');
  if (raw.startsWith(`${REF_VERSION}:`)) {
    const body = raw.slice(REF_VERSION.length + 1);
    const parts = body.split('|');
    if (parts.length >= 5) {
      return {
        schemaVersion: 2,
        kind: parts[2] === 'mp_checkout_pro' ? 'checkout_pro' : 'preapproval',
        organizationId: parts[0],
        planSKU: parts[1] || 'plan-profesional',
        provider: parts[2],
        purpose: parts[3],
        checkoutSessionId: parts[4],
      };
    }
  }
  const { parseExternalReference } = require('../lib/billingProviders');
  const legacy = parseExternalReference(raw);
  if (!legacy) return null;
  return {
    schemaVersion: 1,
    kind: legacy.kind === 'checkout_pro' ? 'checkout_pro' : 'legacy',
    organizationId: legacy.organizationId,
    planSKU: legacy.planSKU,
    provider: legacy.kind === 'checkout_pro' ? 'mp_checkout_pro' : 'mercadopago_preapproval',
    purpose: 'initial',
    checkoutSessionId: legacy.checkoutSessionId,
  };
}

module.exports = {
  REF_VERSION,
  buildExternalReferenceV2,
  buildCheckoutProExternalReferenceV2,
  buildPreapprovalExternalReferenceV2,
  parseExternalReferenceV2,
};
