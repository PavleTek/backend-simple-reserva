'use strict';

/**
 * Dispatcher de eventos normalizados → handlers existentes.
 * Mantiene compatibilidad: los handlers reales siguen en webhooks.routes.js;
 * este módulo expone el kind para persistir normalizedKind.
 */
function getHandlerNameForKind(kind) {
  const map = {
    'subscription.activated': 'preapprovalAuthorized',
    'subscription.payment_failed': 'preapprovalPaymentRequired',
    'subscription.cancelled': 'preapprovalCancelled',
    'payment.approved': 'paymentApproved',
    'payment.recovery': 'paymentRecovery',
    'payment.renewal': 'paymentRenewal',
    'payment.failed': 'paymentRejected',
    'webhook.skipped': 'skipped',
  };
  return map[kind] || 'unknown';
}

module.exports = {
  getHandlerNameForKind,
};
