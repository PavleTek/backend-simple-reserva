'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCollectionMethodChange } = require('./collectionMethodSwitchService');
const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
} = require('../../lib/billingDomain');

test('resolveCollectionMethodChange: automático a manual sin checkout', () => {
  const r = resolveCollectionMethodChange(
    { billingStrategy: BILLING_STRATEGY_AUTOMATIC },
    BILLING_STRATEGY_MANUAL,
  );
  assert.equal(r.kind, 'automatic_to_manual');
});

test('resolveCollectionMethodChange: manual a automático requiere MP', () => {
  const r = resolveCollectionMethodChange(
    { billingStrategy: BILLING_STRATEGY_MANUAL },
    BILLING_STRATEGY_AUTOMATIC,
  );
  assert.equal(r.kind, 'manual_to_automatic');
});

test('resolveCollectionMethodChange: mismo método es noop', () => {
  const r = resolveCollectionMethodChange(
    { billingStrategy: BILLING_STRATEGY_MANUAL },
    BILLING_STRATEGY_MANUAL,
  );
  assert.equal(r.kind, 'noop');
});
