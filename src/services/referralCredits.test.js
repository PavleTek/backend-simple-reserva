'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

test('checkout startDate shifts by credit days', () => {
  const base = new Date('2026-06-01T12:00:00.000Z');
  const credits = [{ amountDays: 30 }, { amountDays: 15 }];
  const totalDays = credits.reduce((s, c) => s + c.amountDays, 0);
  const startDate = addDays(base, totalDays);
  assert.equal(startDate.toISOString().slice(0, 10), '2026-07-16');
});

test('reserved checkout key format', () => {
  const checkoutSessionId = 'csess_abc123';
  assert.equal(`checkout:${checkoutSessionId}`, 'checkout:csess_abc123');
});
