'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMpRetry, isTransientNetworkError } = require('./mpRetry');

test('isTransientNetworkError detects known node-fetch stream errors', () => {
  assert.equal(isTransientNetworkError({ message: 'Invalid response body while trying to fetch https://x: Premature close' }), true);
  assert.equal(isTransientNetworkError({ message: 'socket hang up' }), true);
  assert.equal(isTransientNetworkError({ message: 'resource not found' }), false);
  assert.equal(isTransientNetworkError({ message: undefined }), false);
});

test('withMpRetry returns result on first success without retrying', async () => {
  let calls = 0;
  const result = await withMpRetry(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withMpRetry retries transient errors then succeeds', async () => {
  let calls = 0;
  const result = await withMpRetry(async () => {
    calls++;
    if (calls < 3) {
      throw new Error('Invalid response body while trying to fetch https://x: Premature close');
    }
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withMpRetry does not retry non-transient errors', async () => {
  let calls = 0;
  await assert.rejects(
    withMpRetry(async () => {
      calls++;
      throw new Error('resource not found');
    }, { baseDelayMs: 1 }),
    /resource not found/,
  );
  assert.equal(calls, 1);
});

test('withMpRetry throws last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    withMpRetry(async () => {
      calls++;
      throw new Error('Premature close');
    }, { attempts: 3, baseDelayMs: 1 }),
    /Premature close/,
  );
  assert.equal(calls, 3);
});
