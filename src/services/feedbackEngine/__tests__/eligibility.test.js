'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { checkReservationEligibility, isWalkInReservation } = require('../eligibility');

const baseSurvey = {
  enabled: true,
  excludeWalkIns: true,
  eligibilityMode: 'confirmed_past_end',
  minPartySize: null,
  maxPartySize: null,
};

describe('eligibility', () => {
  it('rejects walk-in when excludeWalkIns', () => {
    const r = {
      status: 'confirmed',
      notes: 'walk-in',
      customerName: 'Juan',
      customerEmail: 'a@b.com',
      partySize: 2,
      dateTime: new Date(Date.now() - 3 * 60 * 60_000),
      durationMinutes: 60,
    };
    assert.equal(isWalkInReservation(r), true);
    const { eligible, skipReason } = checkReservationEligibility(r, baseSurvey);
    assert.equal(eligible, false);
    assert.equal(skipReason, 'walk_in');
  });

  it('rejects when visit not ended', () => {
    const r = {
      status: 'confirmed',
      notes: '',
      customerName: 'Juan',
      customerEmail: 'a@b.com',
      partySize: 2,
      dateTime: new Date(Date.now() + 60 * 60_000),
      durationMinutes: 60,
    };
    const { eligible, skipReason } = checkReservationEligibility(r, baseSurvey);
    assert.equal(eligible, false);
    assert.equal(skipReason, 'visit_not_ended');
  });

  it('accepts completed_only when visit is still in the future', () => {
    const r = {
      status: 'completed',
      notes: '',
      customerName: 'Juan',
      customerEmail: 'a@b.com',
      partySize: 2,
      dateTime: new Date(Date.now() + 24 * 60 * 60_000),
      durationMinutes: 60,
    };
    const survey = { ...baseSurvey, eligibilityMode: 'completed_only' };
    const { eligible, skipReason } = checkReservationEligibility(r, survey);
    assert.equal(eligible, true);
    assert.equal(skipReason, undefined);
  });

  it('rejects completed_only when status is not completed', () => {
    const r = {
      status: 'confirmed',
      notes: '',
      customerName: 'Juan',
      customerEmail: 'a@b.com',
      partySize: 2,
      dateTime: new Date(Date.now() - 3 * 60 * 60_000),
      durationMinutes: 60,
    };
    const survey = { ...baseSurvey, eligibilityMode: 'completed_only' };
    const { eligible, skipReason } = checkReservationEligibility(r, survey);
    assert.equal(eligible, false);
    assert.equal(skipReason, 'not_completed');
  });

  it('accepts confirmed past end', () => {
    const r = {
      status: 'confirmed',
      notes: '',
      customerName: 'Juan',
      customerEmail: 'a@b.com',
      partySize: 2,
      dateTime: new Date(Date.now() - 3 * 60 * 60_000),
      durationMinutes: 60,
    };
    const { eligible } = checkReservationEligibility(r, baseSurvey);
    assert.equal(eligible, true);
  });
});
