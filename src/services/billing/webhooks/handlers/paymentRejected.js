'use strict';

module.exports = async function paymentRejectedHandler(_event) {
  return { handled: true };
};
