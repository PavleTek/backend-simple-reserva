const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultTrialEndsAt,
  shouldManageBillingPeriod,
  shouldClearBillingPeriod,
  resolveTrialEndsAt,
  isTrialPast,
  classifyRepairLogLine,
} = require('./subscriptionRepairService');
const { computePeriodEnd } = require('../lib/billingPeriod');

describe('subscriptionRepairService helpers', () => {
  it('shouldManageBillingPeriod: active sí, trial sin MP no', () => {
    assert.equal(shouldManageBillingPeriod('active', false, null), true);
    assert.equal(shouldManageBillingPeriod('trial', false, null), false);
    assert.equal(shouldManageBillingPeriod('trial', true, 'pre-1'), true);
    assert.equal(shouldManageBillingPeriod('expired', false, null), false);
  });

  it('shouldClearBillingPeriod: trial/expired sin MP con periodo erróneo', () => {
    assert.equal(shouldClearBillingPeriod('trial', false), true);
    assert.equal(shouldClearBillingPeriod('expired', false), true);
    assert.equal(shouldClearBillingPeriod('trial', true), false);
    assert.equal(shouldClearBillingPeriod('active', false), false);
  });

  it('defaultTrialEndsAt suma 14 días calendario y cierra al fin del día Chile', () => {
    const created = new Date('2026-05-14T13:52:18.732Z');
    const end = defaultTrialEndsAt(created);
    const { DateTime } = require('luxon');
    const endLocal = DateTime.fromJSDate(end).setZone('America/Santiago');
    assert.equal(endLocal.toFormat('yyyy-MM-dd'), '2026-05-28');
    assert.equal(endLocal.hour, 23);
  });

  it('resolveTrialEndsAt usa org trialEndsAt si existe', () => {
    const trialEnds = new Date('2026-05-28T13:52:18.708Z');
    const created = new Date('2026-05-14T13:52:18.732Z');
    assert.equal(
      resolveTrialEndsAt(trialEnds, created).toISOString(),
      trialEnds.toISOString(),
    );
  });

  it('isTrialPast detecta fecha pasada', () => {
    assert.equal(isTrialPast(new Date('2020-01-01')), true);
    assert.equal(isTrialPast(new Date('2099-01-01')), false);
  });

  it('computePeriodEnd no debe usarse para trial sin pago (abril → junio en mayo)', () => {
    const start = new Date('2026-04-26T12:00:00.000Z');
    const plan = { billingFrequency: 1, billingFrequencyType: 'months' };
    const end = computePeriodEnd(start, plan);
    assert.ok(end > new Date('2026-05-01'));
    assert.equal(shouldManageBillingPeriod('trial', false, null), false);
  });

  it('classifyRepairLogLine distingue ok, skip y error', () => {
    assert.equal(classifyRepairLogLine('currentPeriodEnd recalculado').type, 'ok');
    assert.equal(classifyRepairLogLine('Ciclo de cobro omitido').type, 'skip');
    assert.equal(classifyRepairLogLine('MP activación fallida').type, 'error');
  });
});
