'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideSwitchToFlowSubUpdate } = require('./paymentProviderSwitchService');

describe('decideSwitchToFlowSubUpdate', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');

  it('cancels active sub and keeps access until period end', () => {
    const periodEnd = new Date('2026-10-01T00:00:00.000Z');
    const decision = decideSwitchToFlowSubUpdate({
      status: 'active',
      currentPeriodEnd: periodEnd,
      startDate: new Date('2026-09-01T00:00:00.000Z'),
    }, now);
    assert.equal(decision.kind, 'cancel_keep_access');
    assert.equal(decision.accessUntil.toISOString(), periodEnd.toISOString());
    assert.equal(decision.keepGraceEndsAt.toISOString(), periodEnd.toISOString());
  });

  it('keeps grace window when already in grace', () => {
    const graceEnd = new Date('2026-09-16T00:00:00.000Z');
    const decision = decideSwitchToFlowSubUpdate({
      status: 'grace',
      currentPeriodEnd: new Date('2026-09-09T00:00:00.000Z'),
      gracePeriodEndsAt: graceEnd,
    }, now);
    assert.equal(decision.kind, 'cancel_keep_access');
    assert.equal(decision.keepGraceEndsAt.toISOString(), graceEnd.toISOString());
  });

  it('is flag_only when there is no live access', () => {
    const decision = decideSwitchToFlowSubUpdate({
      status: 'expired',
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-01T00:00:00.000Z'),
    }, now);
    assert.equal(decision.kind, 'flag_only');
  });

  it('is none when there is no sub', () => {
    assert.equal(decideSwitchToFlowSubUpdate(null, now).kind, 'none');
  });
});
