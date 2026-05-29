'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isInReferralFreeWindow,
  deferredStartDateForCollectionSwitch,
} = require('./billing/referralFreeWindowService');
const { addDays } = require('./referralService');

test('isInReferralFreeWindow is true while referralFreeUntil is in the future', () => {
  const future = addDays(new Date(), 10);
  assert.equal(isInReferralFreeWindow({ referralFreeUntil: future }), true);
});

test('isInReferralFreeWindow is false when referralFreeUntil is null or past', () => {
  assert.equal(isInReferralFreeWindow({ referralFreeUntil: null }), false);
  const past = addDays(new Date(), -1);
  assert.equal(isInReferralFreeWindow({ referralFreeUntil: past }), false);
});

test('deferredStartDateForCollectionSwitch returns referralFreeUntil during active window', () => {
  const freeUntil = addDays(new Date(), 15);
  const sub = { referralFreeUntil: freeUntil };
  const deferred = deferredStartDateForCollectionSwitch(sub);
  assert.ok(deferred instanceof Date);
  assert.equal(deferred.toISOString(), freeUntil.toISOString());
});

test('deferredStartDateForCollectionSwitch returns null outside window', () => {
  assert.equal(deferredStartDateForCollectionSwitch({ referralFreeUntil: null }), null);
  assert.equal(
    deferredStartDateForCollectionSwitch({ referralFreeUntil: addDays(new Date(), -2) }),
    null,
  );
});

test('getAvailableCreditDays sums available credits', async () => {
  const { getAvailableCreditDays } = require('./referralService');
  const credits = [{ amountDays: 30 }, { amountDays: 15 }];
  const total = credits.reduce((s, c) => s + c.amountDays, 0);
  assert.equal(total, 45);
  assert.equal(typeof getAvailableCreditDays, 'function');
});

test('applyAvailableCreditsOnNextCheckout requires checkoutSessionId', async () => {
  const { applyAvailableCreditsOnNextCheckout } = require('./referralService');
  await assert.rejects(
    () => applyAvailableCreditsOnNextCheckout('org_test', null, null),
    (err) => err.statusCode === 500,
  );
});

test('freeUntil calculation from credit days', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const totalDays = 45;
  const freeUntil = addDays(now, totalDays);
  assert.equal(freeUntil.toISOString().slice(0, 10), '2026-07-16');
});
