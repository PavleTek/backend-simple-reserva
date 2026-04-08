const test = require('node:test');
const assert = require('node:assert/strict');
const { getPasswordPolicyError, MIN_PASSWORD_LENGTH } = require('./passwordPolicy');

test('getPasswordPolicyError acepta contraseña válida', () => {
  assert.equal(getPasswordPolicyError('12345678'), null);
});

test('getPasswordPolicyError rechaza corta', () => {
  const msg = getPasswordPolicyError('short');
  assert.ok(msg && msg.includes(String(MIN_PASSWORD_LENGTH)));
});

test('getPasswordPolicyError rechaza no string', () => {
  assert.ok(getPasswordPolicyError(null));
});
