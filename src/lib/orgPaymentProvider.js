'use strict';

const prisma = require('./prisma');
const { PAYMENT_PROVIDER_FLOW, PAYMENT_PROVIDER_MERCADOPAGO } = require('./billingDomain');

function normalizeOrgPaymentProvider(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === PAYMENT_PROVIDER_FLOW) return PAYMENT_PROVIDER_FLOW;
  return PAYMENT_PROVIDER_MERCADOPAGO;
}

function isFlowOrganization(orgOrId) {
  if (orgOrId && typeof orgOrId === 'object') {
    return normalizeOrgPaymentProvider(orgOrId.paymentProvider) === PAYMENT_PROVIDER_FLOW;
  }
  return false;
}

async function getOrgPaymentProvider(organizationId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { paymentProvider: true },
  });
  return normalizeOrgPaymentProvider(org?.paymentProvider);
}

async function isFlowOrganizationId(organizationId) {
  const psp = await getOrgPaymentProvider(organizationId);
  return psp === PAYMENT_PROVIDER_FLOW;
}

module.exports = {
  normalizeOrgPaymentProvider,
  isFlowOrganization,
  getOrgPaymentProvider,
  isFlowOrganizationId,
};
