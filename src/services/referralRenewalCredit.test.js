'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('./referralService');
const { evaluateRenewalCreditEligibility } = require('./billing/referralRenewalCreditService');

function activeSub(overrides = {}) {
  const periodEnd = addDays(new Date(), 20);
  return {
    status: 'active',
    isActiveSubscription: true,
    currentPeriodEnd: periodEnd,
    scheduledPlanId: null,
    referralFreeUntil: null,
    referralFreeWindowStartsAt: null,
    ...overrides,
  };
}

test('evaluateRenewalCreditEligibility allows active sub with credits', () => {
  const result = evaluateRenewalCreditEligibility(activeSub(), 30);
  assert.equal(result.eligible, true);
});

test('evaluateRenewalCreditEligibility blocks when no credits', () => {
  const result = evaluateRenewalCreditEligibility(activeSub(), 0);
  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'no_credits');
});

test('evaluateRenewalCreditEligibility blocks scheduled plan change', () => {
  const result = evaluateRenewalCreditEligibility(activeSub({ scheduledPlanId: 'plan_x' }), 30);
  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'scheduled_change');
});

test('evaluateRenewalCreditEligibility blocks active free window', () => {
  const freeUntil = addDays(new Date(), 15);
  const result = evaluateRenewalCreditEligibility(
    activeSub({ referralFreeUntil: freeUntil }),
    30,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'in_free_window');
});

test('evaluateRenewalCreditEligibility blocks deferred extension already scheduled', () => {
  const startsAt = addDays(new Date(), 5);
  const freeUntil = addDays(new Date(), 35);
  const result = evaluateRenewalCreditEligibility(
    activeSub({ referralFreeWindowStartsAt: startsAt, referralFreeUntil: freeUntil }),
    0,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'in_free_window');
});

test('evaluateRenewalCreditEligibility blocks grace status', () => {
  const result = evaluateRenewalCreditEligibility(
    activeSub({ status: 'grace', gracePeriodEndsAt: addDays(new Date(), 5) }),
    30,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'grace');
});
