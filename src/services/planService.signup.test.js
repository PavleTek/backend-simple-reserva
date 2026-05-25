const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSignupPlanSKU, SIGNUP_DEFAULT_PLAN } = require('./planService');

test('public signup always resolves to plan-basico', () => {
  assert.equal(resolveSignupPlanSKU(undefined), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU(null), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU(''), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU('plan-basico'), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU('plan-profesional'), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU('plan-premium'), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU('  plan-premium  '), SIGNUP_DEFAULT_PLAN);
  assert.equal(resolveSignupPlanSKU('plan-invalid'), SIGNUP_DEFAULT_PLAN);
});
