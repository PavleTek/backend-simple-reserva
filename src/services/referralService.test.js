'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getReferralConfig,
  REFERRAL_STATUSES,
  INVALID_REFERRAL_MSG,
  REFERRAL_PLAN_SKU,
} = require('./referralService');

test('getReferralConfig returns sane defaults', () => {
  const prev = {
    REFERRAL_REWARD_DAYS: process.env.REFERRAL_REWARD_DAYS,
    REFERRAL_REFEREE_GRANT_DAYS: process.env.REFERRAL_REFEREE_GRANT_DAYS,
    REFERRAL_MIN_ACTIVE_DAYS: process.env.REFERRAL_MIN_ACTIVE_DAYS,
  };
  delete process.env.REFERRAL_REWARD_DAYS;
  delete process.env.REFERRAL_REFEREE_GRANT_DAYS;
  delete process.env.REFERRAL_MIN_ACTIVE_DAYS;

  const config = getReferralConfig();
  assert.equal(config.rewardDays, 30);
  assert.equal(config.refereeGrantDays, 30);
  assert.equal(config.minActiveDays, 30);
  assert.ok(config.landingBaseUrl.includes('http'));

  Object.assign(process.env, prev);
});

test('referral constants', () => {
  assert.equal(REFERRAL_PLAN_SKU, 'plan-profesional');
  assert.equal(INVALID_REFERRAL_MSG, 'Código de referido no válido.');
  assert.equal(REFERRAL_STATUSES.AWAITING_ADMIN_APPROVAL, 'awaiting_admin_approval');
});

test('validateReferrerOrgId rejects empty org id', async () => {
  const { validateReferrerOrgId } = require('./referralService');
  await assert.rejects(
    () => validateReferrerOrgId(''),
    (err) => err.message === INVALID_REFERRAL_MSG,
  );
});
