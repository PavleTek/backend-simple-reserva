'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyMpPaymentFailure } = require('./mpPaymentFailureReason');
const {
  renewalKindFromDaysLeft,
  periodKeyFromPeriodEnd,
  periodKeyFromGrace,
  BILLING_EMAIL_KINDS,
} = require('../services/billing/billingEmailService');

describe('classifyMpPaymentFailure', () => {
  it('mapea fondos insuficientes', () => {
    const r = classifyMpPaymentFailure({
      id: 123,
      status: 'rejected',
      status_detail: 'cc_rejected_insufficient_amount',
    });
    assert.match(r.ownerMessage, /fondos/i);
    assert.match(r.adminHint, /tarjeta/i);
    assert.equal(r.paymentId, '123');
  });

  it('fallback genérico', () => {
    const r = classifyMpPaymentFailure({ status: 'rejected', status_detail: 'unknown_code' });
    assert.match(r.ownerMessage, /Facturación/i);
    assert.match(r.adminHint, /MP status=rejected/);
  });
});

describe('billingEmailService helpers', () => {
  it('renewalKindFromDaysLeft', () => {
    assert.equal(renewalKindFromDaysLeft(7), BILLING_EMAIL_KINDS.RENEWAL_7D);
    assert.equal(renewalKindFromDaysLeft(4), BILLING_EMAIL_KINDS.RENEWAL_4D);
    assert.equal(renewalKindFromDaysLeft(1), BILLING_EMAIL_KINDS.RENEWAL_1D);
    assert.equal(renewalKindFromDaysLeft(3), null);
  });

  it('periodKeyFromPeriodEnd usa fecha Chile', () => {
    const key = periodKeyFromPeriodEnd(new Date('2026-06-15T03:00:00.000Z'));
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('periodKeyFromGrace incluye prefijo', () => {
    const key = periodKeyFromGrace(new Date('2026-06-20T12:00:00.000Z'));
    assert.match(key, /^grace:/);
  });
});
