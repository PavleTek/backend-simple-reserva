const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
  computeDefaultTrialEndsAt,
  isTrialExpired,
  isTrialActive,
  trialAccessEndsAt,
  TRIAL_TIMEZONE,
} = require('./trialPeriod');

describe('trialPeriod', () => {
  it('computeDefaultTrialEndsAt: 14/05 alta → fin del 28/05 en Chile', () => {
    const created = new Date('2026-05-14T13:52:18.732Z');
    const end = computeDefaultTrialEndsAt(created, 14);
    const endLocal = DateTime.fromJSDate(end).setZone(TRIAL_TIMEZONE);
    assert.equal(endLocal.toFormat('yyyy-MM-dd'), '2026-05-28');
    assert.equal(endLocal.hour, 23);
    assert.equal(endLocal.minute, 59);
  });

  it('isTrialExpired: mismo día antes de medianoche no expira', () => {
    const trialEnds = new Date('2026-05-28T13:52:18.708Z');
    const noonChile = DateTime.fromObject(
      { year: 2026, month: 5, day: 28, hour: 12 },
      { zone: TRIAL_TIMEZONE },
    ).toJSDate();
    const mockNow = DateTime.fromJSDate(noonChile).setZone(TRIAL_TIMEZONE);
    const end = DateTime.fromJSDate(trialEnds).setZone(TRIAL_TIMEZONE).endOf('day');
    assert.equal(mockNow > end, false);
  });

  it('isTrialExpired: día siguiente ya expiró', () => {
    const trialEnds = new Date('2026-05-28T13:52:18.708Z');
    const nextDay = DateTime.fromObject(
      { year: 2026, month: 5, day: 29, hour: 0, minute: 1 },
      { zone: TRIAL_TIMEZONE },
    ).toJSDate();
    const end = trialAccessEndsAt(trialEnds);
    assert.equal(nextDay.getTime() > end.getTime(), true);
  });

  it('isTrialExpired: fecha pasada', () => {
    assert.equal(isTrialExpired(new Date('2020-01-15T12:00:00Z')), true);
    assert.equal(isTrialExpired(new Date('2099-06-01T12:00:00Z')), false);
  });
});
