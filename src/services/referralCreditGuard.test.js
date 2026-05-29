'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('./referralService');
const {
  isReferralCreditPeriodLocked,
  evaluatePlanChangeReferralPolicy,
  deferredChargeDateForReferralCredits,
} = require('./billing/referralCreditGuardService');

test('isReferralCreditPeriodLocked during scheduled extension', () => {
  const startsAt = addDays(new Date(), 5);
  const freeUntil = addDays(new Date(), 35);
  const sub = { referralFreeUntil: freeUntil, referralFreeWindowStartsAt: startsAt };
  assert.equal(isReferralCreditPeriodLocked(sub), true);
});

test('isReferralCreditPeriodLocked false without referralFreeUntil', () => {
  assert.equal(isReferralCreditPeriodLocked({}), false);
});

test('evaluatePlanChangeReferralPolicy blocks during credit period', () => {
  const freeUntil = addDays(new Date(), 20);
  const policy = evaluatePlanChangeReferralPolicy({
    sub: { referralFreeUntil: freeUntil, referralFreeWindowStartsAt: addDays(new Date(), -2) },
    currentSku: 'plan-profesional',
    newSku: 'plan-profesional-custom',
    creditsAvailableDays: 0,
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.code, 'referral_period_locked');
});

test('evaluatePlanChangeReferralPolicy blocks cross-tier with available credits', () => {
  const policy = evaluatePlanChangeReferralPolicy({
    sub: {},
    currentSku: 'plan-basico',
    newSku: 'plan-profesional',
    creditsAvailableDays: 30,
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.code, 'referral_credits_cross_tier');
});

test('evaluatePlanChangeReferralPolicy requires forfeit for same-tier with credits', () => {
  const policy = evaluatePlanChangeReferralPolicy({
    sub: {},
    currentSku: 'plan-profesional',
    newSku: 'plan-profesional',
    creditsAvailableDays: 30,
    confirmForfeitReferralCredits: false,
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.code, 'referral_credits_forfeit_required');
});

test('evaluatePlanChangeReferralPolicy allows same-tier with forfeit confirm', () => {
  const policy = evaluatePlanChangeReferralPolicy({
    sub: {},
    currentSku: 'plan-basico',
    newSku: 'plan-basico',
    creditsAvailableDays: 30,
    confirmForfeitReferralCredits: true,
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.forfeitAvailableCredits, true);
});

test('deferredChargeDateForReferralCredits during scheduled extension', () => {
  const startsAt = addDays(new Date(), 3);
  const freeUntil = addDays(new Date(), 33);
  const sub = { referralFreeUntil: freeUntil, referralFreeWindowStartsAt: startsAt };
  const deferred = deferredChargeDateForReferralCredits(sub);
  assert.ok(deferred instanceof Date);
  assert.equal(deferred.toISOString(), freeUntil.toISOString());
});
