'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  isCompletedOnlyMode,
  resolveScheduledFor,
  shouldAutoSendOnStatusChange,
  evaluateSendWindowForReservation,
} = require('../scheduling');

describe('scheduling modes', () => {
  it('completed_only resolves scheduledFor to now when completed', () => {
    const survey = { eligibilityMode: 'completed_only', sendDelayMinutes: 60, sendWindowMinutes: 240 };
    const reservation = {
      status: 'completed',
      dateTime: new Date(Date.now() + 24 * 60 * 60_000),
      durationMinutes: 60,
    };
    assert.equal(isCompletedOnlyMode(survey), true);
    const scheduled = resolveScheduledFor(reservation, survey);
    assert.ok(scheduled.getTime() <= Date.now() + 5000);
  });

  it('shouldAutoSendOnStatusChange is true for completed_only when completed', () => {
    const survey = { eligibilityMode: 'completed_only', enabled: true, sendWindowMinutes: 240 };
    const reservation = {
      status: 'completed',
      dateTime: new Date(Date.now() + 24 * 60 * 60_000),
      durationMinutes: 60,
    };
    assert.equal(shouldAutoSendOnStatusChange(reservation, survey), true);
  });

  it('confirmed_past_end does not auto-send before visit ends', () => {
    const survey = {
      eligibilityMode: 'confirmed_past_end',
      enabled: true,
      sendDelayMinutes: 60,
      sendWindowMinutes: 240,
    };
    const reservation = {
      status: 'completed',
      dateTime: new Date(Date.now() + 24 * 60 * 60_000),
      durationMinutes: 60,
    };
    assert.equal(shouldAutoSendOnStatusChange(reservation, survey), false);
    const w = evaluateSendWindowForReservation(reservation, survey);
    assert.equal(w.label, 'visit_not_ended');
  });
});
