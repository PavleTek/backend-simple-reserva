'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { signFlowParams } = require('./flowClient');

describe('signFlowParams', () => {
  it('sorts keys alphabetically and concatenates name+value before HMAC', () => {
    const secret = 'secret';
    const a = signFlowParams({ apiKey: 'XXXX-XXXX-XXXX', currency: 'CLP', amount: 5000 }, secret);
    const b = signFlowParams({ currency: 'CLP', amount: 5000, apiKey: 'XXXX-XXXX-XXXX' }, secret);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('omits s and null/undefined values', () => {
    const secret = 'secret';
    const withNulls = signFlowParams({ apiKey: 'k', token: 't', s: 'ignore-me', extra: null }, secret);
    const clean = signFlowParams({ apiKey: 'k', token: 't' }, secret);
    assert.equal(withNulls, clean);
  });
});
