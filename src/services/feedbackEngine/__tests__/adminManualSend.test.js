'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Regresión: el panel admin enviaba resend:false cuando emailSent era false,
 * lo que desactivaba allowResend y devolvía cooldown sin aplicar bypass.
 */
describe('admin manual send contract', () => {
  it('ADMIN_SEND_OVERRIDES incluye bypass de cooldown y reintento', () => {
    const { ADMIN_SEND_OVERRIDES } = require('../sendFeedback');
    assert.equal(ADMIN_SEND_OVERRIDES.bypassCooldown, true);
    assert.equal(ADMIN_SEND_OVERRIDES.allowResend, true);
  });
});
