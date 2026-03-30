const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePeriodEnd, estimateNextPaymentDate } = require('./billingPeriod');

test('computePeriodEnd avanza al siguiente periodo mensual', () => {
  const start = new Date('2024-01-15T12:00:00.000Z');
  const plan = { billingFrequency: 1, billingFrequencyType: 'months' };
  const end = computePeriodEnd(start, plan);
  assert.ok(end instanceof Date);
  assert.ok(end > start);
});

test('estimateNextPaymentDate solo para suscripción activa', () => {
  const plan = { billingFrequency: 1, billingFrequencyType: 'months' };
  assert.equal(estimateNextPaymentDate({ status: 'trial', startDate: new Date() }, plan), null);
  const start = new Date(Date.now() - 86400000);
  const iso = estimateNextPaymentDate({ status: 'active', startDate: start }, plan);
  assert.ok(typeof iso === 'string');
});
