'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePendingSendReason } = require('../feedbackEnqueue');

describe('resolvePendingSendReason', () => {
  it('marca cooldown aunque la reserva sea elegible y la ventana sea on_complete', () => {
    const r = resolvePendingSendReason({
      emailSent: false,
      declinedSurveys: false,
      eligible: true,
      eligibilityReason: null,
      skipReason: null,
      sendWindowState: 'on_complete',
      inSendWindow: true,
      cooldownInfo: {
        onCooldown: true,
        cooldownUntil: '2026-06-01T12:00:00.000Z',
      },
    });
    assert.equal(r.pendingSendReason, 'cooldown');
    assert.equal(r.cooldownUntil, '2026-06-01T12:00:00.000Z');
  });

  it('sin cooldown usa motivo de ventana o elegibilidad', () => {
    const r = resolvePendingSendReason({
      emailSent: false,
      declinedSurveys: false,
      eligible: false,
      eligibilityReason: 'not_completed',
      skipReason: null,
      sendWindowState: 'pending_completion',
      inSendWindow: false,
      cooldownInfo: { onCooldown: false, cooldownUntil: null },
    });
    assert.equal(r.pendingSendReason, 'not_completed');
  });
});
