'use strict';

const { parseExternalReferenceV2 } = require('../../../lib/externalReferenceV2');
const { parseExternalReference } = require('../../../lib/billingProviders');

/**
 * Normaliza payload MP → DomainEvent.
 * @param {{ type: string, data: { id: string }, mpEntity?: object }} input
 */
function normalizeMercadoPagoWebhook(input) {
  const { type, data, mpEntity } = input;
  const dataId = data?.id != null ? String(data.id) : null;
  if (!type || !dataId) return null;

  if (type === 'subscription_preapproval' || type === 'subscription_authorized_payment') {
    const externalRef = mpEntity?.external_reference;
    const parsed = parseExternalReferenceV2(externalRef) || parseExternalReference(externalRef);
    const status = mpEntity?.status ?? mpEntity?.Status ?? null;
    let kind = 'subscription.unknown';
    if (status === 'authorized' || status === 'approved') kind = 'subscription.activated';
    else if (status === 'payment_required') kind = 'subscription.payment_failed';
    else if (status === 'cancelled' || status === 'expired') kind = 'subscription.cancelled';

    return {
      kind,
      mpEventType: type,
      mpDataId: dataId,
      organizationId: parsed?.organizationId ?? null,
      planSKU: parsed?.planSKU ?? null,
      externalRef,
      status,
      preapprovalId: dataId,
    };
  }

  if (type === 'payment') {
    const externalRef = mpEntity?.external_reference;
    const parsed = parseExternalReferenceV2(externalRef) || parseExternalReference(externalRef);
    const status = mpEntity?.status ?? null;
    const meta = mpEntity?.metadata || {};
    let kind = 'payment.unknown';
    if (status === 'approved') {
      if (meta.purpose === 'recovery' || parsed?.purpose === 'recovery') kind = 'payment.recovery';
      else if (meta.renewal === true || meta.renewal === 'true') kind = 'payment.renewal';
      else kind = 'payment.approved';
    } else if (status === 'rejected' || status === 'cancelled') {
      kind = 'payment.failed';
    }

    return {
      kind,
      mpEventType: type,
      mpDataId: dataId,
      organizationId: parsed?.organizationId ?? null,
      planSKU: parsed?.planSKU ?? null,
      externalRef,
      status,
      paymentId: dataId,
      purpose: parsed?.purpose ?? meta.purpose ?? null,
    };
  }

  return {
    kind: 'webhook.skipped',
    mpEventType: type,
    mpDataId: dataId,
    organizationId: null,
    planSKU: null,
    externalRef: null,
    status: null,
  };
}

module.exports = {
  normalizeMercadoPagoWebhook,
};
