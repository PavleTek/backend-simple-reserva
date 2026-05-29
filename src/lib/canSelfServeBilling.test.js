'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canSelfServeBilling } = require('./canSelfServeBilling');

test('canSelfServeBilling: activo con acceso', () => {
  const r = canSelfServeBilling({ isActiveSubscription: true, status: 'active' });
  assert.equal(r.allowed, true);
});

test('canSelfServeBilling: grace bloqueado', () => {
  const r = canSelfServeBilling({ isActiveSubscription: true, status: 'grace' });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'grace');
});

test('canSelfServeBilling: cancelled con acceso requiere reactivar', () => {
  const r = canSelfServeBilling({ isActiveSubscription: true, status: 'cancelled' });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'cancelled_in_period');
});

test('canSelfServeBilling: trial permitido', () => {
  const r = canSelfServeBilling({ isActiveSubscription: true, status: 'trial' });
  assert.equal(r.allowed, true);
});
