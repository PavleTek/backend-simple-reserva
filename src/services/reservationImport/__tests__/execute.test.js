'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotificationFlags } = require('../execute');

describe('buildNotificationFlags', () => {
  it('past confirmed is fully silent', () => {
    const flags = buildNotificationFlags(
      { isFuture: false, status: 'confirmed' },
      { notifyFutureReminders: true },
    );
    assert.equal(flags.emailSent, true);
    assert.equal(flags.reminderEmailSent, true);
    assert.equal(flags.teamNotifySent, true);
    assert.equal(flags.teamNotifySkipReason, 'imported');
  });

  it('future confirmed: no customer confirm, reminders on, team pending', () => {
    const flags = buildNotificationFlags(
      { isFuture: true, status: 'confirmed', customerEmail: 'a@b.cl' },
      { notifyFutureReminders: true },
    );
    assert.equal(flags.emailSent, true);
    assert.equal(flags.reminderEmailSent, false);
    assert.equal(flags.teamNotifySent, false);
    assert.equal(flags.teamNotifySkipReason, null);
  });

  it('future confirmed with reminders off', () => {
    const flags = buildNotificationFlags(
      { isFuture: true, status: 'confirmed' },
      { notifyFutureReminders: false },
    );
    assert.equal(flags.reminderEmailSent, true);
  });

  it('future cancelled is silent', () => {
    const flags = buildNotificationFlags(
      { isFuture: true, status: 'cancelled' },
      { notifyFutureReminders: true },
    );
    assert.equal(flags.teamNotifySent, true);
  });
});
