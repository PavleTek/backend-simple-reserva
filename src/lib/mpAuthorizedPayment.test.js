'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePreapprovalIdFromAuthorizedPayment } = require('./mpAuthorizedPayment');

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = original;
  });
}

test('resolvePreapprovalIdFromAuthorizedPayment returns preapproval_id on success', async () => {
  await withMockedFetch(
    async () => ({ json: async () => ({ preapproval_id: 'pa_123' }) }),
    async () => {
      const id = await resolvePreapprovalIdFromAuthorizedPayment('ap_1', 'token');
      assert.equal(id, 'pa_123');
    },
  );
});

test('resolvePreapprovalIdFromAuthorizedPayment throws noPreapprovalId when MP has no match', async () => {
  await withMockedFetch(
    async () => ({ json: async () => ({ error: 'resource not found' }) }),
    async () => {
      await assert.rejects(
        resolvePreapprovalIdFromAuthorizedPayment('ap_missing', 'token'),
        (err) => {
          assert.equal(err.noPreapprovalId, true);
          assert.deepEqual(err.authorizedPaymentData, { error: 'resource not found' });
          return true;
        },
      );
    },
  );
});

test('resolvePreapprovalIdFromAuthorizedPayment retries transient network errors then succeeds', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls++;
      if (calls < 2) throw new Error('Premature close');
      return { json: async () => ({ preapproval_id: 'pa_456' }) };
    },
    async () => {
      const id = await resolvePreapprovalIdFromAuthorizedPayment('ap_2', 'token');
      assert.equal(id, 'pa_456');
      assert.equal(calls, 2);
    },
  );
});
