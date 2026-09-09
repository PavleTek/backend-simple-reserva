'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('buildFlowPlanId', () => {
  const prevEnv = process.env.FLOW_ENV;
  const prevNode = process.env.NODE_ENV;

  after(() => {
    if (prevEnv === undefined) delete process.env.FLOW_ENV;
    else process.env.FLOW_ENV = prevEnv;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    delete require.cache[require.resolve('../lib/flowEnv')];
    delete require.cache[require.resolve('./flowService')];
  });

  function load() {
    delete require.cache[require.resolve('../lib/flowEnv')];
    delete require.cache[require.resolve('./flowService')];
    return require('./flowService');
  }

  it('uses dsr prefix in development and is deterministic', () => {
    process.env.FLOW_ENV = 'development';
    const { buildFlowPlanId } = load();
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
    assert.match(a, /^dsr[a-f0-9]{20}$/);
    assert.ok(a.length <= 23);
  });

  it('uses sr prefix in production', () => {
    process.env.FLOW_ENV = 'production';
    const { buildFlowPlanId } = load();
    const id = buildFlowPlanId({
      productSKU: 'plan-profesional',
      grossAmount: 23788,
      interval: 3,
      intervalCount: 1,
    });
    assert.match(id, /^sr[a-f0-9]{20}$/);
    assert.ok(id.length <= 23);
  });

  it('changes when amount changes', () => {
    process.env.FLOW_ENV = 'development';
    const { buildFlowPlanId } = load();
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
