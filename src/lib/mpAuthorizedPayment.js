'use strict';

const { withMpRetry } = require('./mpRetry');

/**
 * Resuelve el preapproval_id real a partir del id de un evento subscription_authorized_payment.
 * En ese tipo de evento data.id es el id del cobro (authorized payment / "invoice"), NO el
 * preapproval id — hay que resolverlo antes de poder consultar GET /preapproval/{id}.
 *
 * Lanza con `err.noPreapprovalId = true` si MP responde pero el authorized_payment no trae
 * preapproval_id (evento no accionable, no es un error transitorio).
 */
async function resolvePreapprovalIdFromAuthorizedPayment(authorizedPaymentId, accessToken) {
  const res = await withMpRetry(() => fetch(
    `https://api.mercadopago.com/v1/authorized_payments/${authorizedPaymentId}`,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
  ));
  const data = await res.json();
  const preapprovalId = data?.preapproval_id;
  if (!preapprovalId) {
    const err = new Error('no preapproval_id en authorized_payment');
    err.noPreapprovalId = true;
    err.authorizedPaymentData = data;
    throw err;
  }
  return preapprovalId;
}

module.exports = { resolvePreapprovalIdFromAuthorizedPayment };
