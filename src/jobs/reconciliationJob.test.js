'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activeSubNeedsMpCheck } = require('./reconciliationJob');

const now = new Date('2026-06-15T12:00:00Z');

test('no llama a MP si el periodo vence en más de 7 días', () => {
  const end = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
  assert.equal(
    activeSubNeedsMpCheck({ mercadopagoPreapprovalId: 'pre', currentPeriodEnd: end }, now),
    false,
  );
});

test('sí llama a MP si el periodo vence dentro de 7 días, ya venció, o no tiene fecha', () => {
  const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 60 * 1000);
  assert.equal(
    activeSubNeedsMpCheck({ mercadopagoPreapprovalId: 'pre', currentPeriodEnd: soon }, now),
    true,
  );
  assert.equal(
    activeSubNeedsMpCheck({ mercadopagoPreapprovalId: 'pre', currentPeriodEnd: past }, now),
    true,
  );
  assert.equal(
    activeSubNeedsMpCheck({ mercadopagoPreapprovalId: 'pre', currentPeriodEnd: null }, now),
    true,
  );
});
