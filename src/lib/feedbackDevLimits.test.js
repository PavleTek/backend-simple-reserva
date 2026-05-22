const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadValidate(env) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  const resolved = require.resolve('./feedbackDevLimits');
  delete require.cache[resolved];
  const { validateSendDelayMinutes } = require('./feedbackDevLimits');
  process.env.NODE_ENV = prev;
  delete require.cache[resolved];
  return validateSendDelayMinutes;
}

test('validateSendDelayMinutes accepts 1 in development', () => {
  const validate = loadValidate('development');
  const result = validate(1);
  assert.equal(result.ok, true);
  assert.equal(result.value, 1);
});

test('validateSendDelayMinutes rejects 1 in production', () => {
  const validate = loadValidate('production');
  const result = validate(1);
  assert.equal(result.ok, false);
});

test('validateSendDelayMinutes accepts 15 in production', () => {
  const validate = loadValidate('production');
  const result = validate(15);
  assert.equal(result.ok, true);
  assert.equal(result.value, 15);
});

test('validateSendDelayMinutes accepts 1 for admin in production', () => {
  const validate = loadValidate('production');
  const result = validate(1, { admin: true });
  assert.equal(result.ok, true);
  assert.equal(result.value, 1);
});
