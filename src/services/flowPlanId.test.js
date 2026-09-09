'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFlowPlanId } = require('./flowService');

describe('buildFlowPlanId', () => {
  it('uses sr prefix and is deterministic', () => {
    const a = buildFlowPlanId({
      productSKU: 'plan-profesional',
      grossAmount: 23788,
      interval: 3,
      intervalCount: 1,
    });
    const b = buildFlowPlanId({
      productSKU: 'plan-profesional',
      grossAmount: 23788,
      interval: 3,
      intervalCount: 1,
    });
    assert.equal(a, b);
    assert.match(a, /^sr[a-f0-9]{20}$/);
    assert.ok(a.length <= 23);
  });

  it('changes when amount changes', () => {
    const a = buildFlowPlanId({
      productSKU: 'plan-profesional',
      grossAmount: 23788,
      interval: 3,
      intervalCount: 1,
    });
    const b = buildFlowPlanId({
      productSKU: 'plan-profesional',
      grossAmount: 35700,
      interval: 3,
      intervalCount: 1,
    });
    assert.notEqual(a, b);
  });
});
