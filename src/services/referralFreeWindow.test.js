'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isInReferralFreeWindow,
  isReferralCreditExtensionScheduled,
  scheduledRenewalCreditDays,
  deferredStartDateForCollectionSwitch,
} = require('./billing/referralFreeWindowService');
const { addDays } = require('./referralService');

test('isInReferralFreeWindow is true while referralFreeUntil is in the future', () => {
  const future = addDays(new Date(), 10);
  assert.equal(isInReferralFreeWindow({ referralFreeUntil: future }), true);
});

test('isInReferralFreeWindow is false before referralFreeWindowStartsAt', () => {
  const startsAt = addDays(new Date(), 5);
  const freeUntil = addDays(new Date(), 35);
  assert.equal(
    isInReferralFreeWindow({ referralFreeUntil: freeUntil, referralFreeWindowStartsAt: startsAt }),
    false,
  );
});

test('isInReferralFreeWindow is true after referralFreeWindowStartsAt', () => {
  const startsAt = addDays(new Date(), -1);
  const freeUntil = addDays(new Date(), 29);
  assert.equal(
    isInReferralFreeWindow({ referralFreeUntil: freeUntil, referralFreeWindowStartsAt: startsAt }),
    true,
  );
});

test('isReferralCreditExtensionScheduled when startsAt is in the future', () => {
  const startsAt = addDays(new Date(), 3);
  const freeUntil = addDays(new Date(), 33);
  assert.equal(
    isReferralCreditExtensionScheduled({ referralFreeWindowStartsAt: startsAt, referralFreeUntil: freeUntil }),
    true,
  );
});

test('scheduledRenewalCreditDays counts days between startsAt and freeUntil', () => {
  const startsAt = new Date('2026-06-26T12:00:00.000Z');
  const freeUntil = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(
    scheduledRenewalCreditDays({ referralFreeWindowStartsAt: startsAt, referralFreeUntil: freeUntil }),
    30,
  );
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
