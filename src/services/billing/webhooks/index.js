'use strict';

/** Handlers de dominio para webhooks MP (P2.1). La lógica principal sigue en webhooks.routes.js. */

module.exports = {
  subscriptionActivated: require('./handlers/subscriptionActivated'),
  paymentApproved: require('./handlers/paymentApproved'),
  paymentRejected: require('./handlers/paymentRejected'),
  checkoutProCompleted: require('./handlers/checkoutProCompleted'),
};
