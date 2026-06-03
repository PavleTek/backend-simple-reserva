'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransitionActivityBookingStatus,
  ACTIVE_ACTIVITY_BOOKING_STATUSES,
} = require('./activityBookingStatuses');

describe('activityBookingStatuses', () => {
  it('allows confirmed to arrived', () => {
    assert.equal(canTransitionActivityBookingStatus('CONFIRMED', 'ARRIVED'), true);
  });

  it('blocks invalid transition', () => {
    assert.equal(canTransitionActivityBookingStatus('COMPLETED', 'PENDING'), false);
  });

  it('includes PENDING as active capacity', () => {
    assert.ok(ACTIVE_ACTIVITY_BOOKING_STATUSES.includes('PENDING'));
    assert.ok(ACTIVE_ACTIVITY_BOOKING_STATUSES.includes('CONFIRMED'));
  });
});
