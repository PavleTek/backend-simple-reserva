'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  computeBusinessDate,
  resolveCalendarDateFromBusinessDate,
} = require('../businessDate');

describe('businessDate cross-midnight', () => {
  const tuesdaySchedule = {
    dayOfWeek: 2,
    openTime: '12:00',
    closeTime: '02:00',
    closesNextDay: true,
  };

  it('resolveCalendarDateFromBusinessDate mueve 01:00 al día calendario siguiente', () => {
    const r = resolveCalendarDateFromBusinessDate(
      '2026-05-26',
      '01:00',
      tuesdaySchedule,
      'continuous',
    );
    assert.equal(r.calendarDateStr, '2026-05-27');
    assert.equal(r.dayOffset, 1);
  });

  it('computeBusinessDate ancla 01:00 del miércoles al martes hábil', () => {
    const business = computeBusinessDate(
      '2026-05-27',
      '01:00',
      tuesdaySchedule,
      'continuous',
      'America/Santiago',
    );
    assert.equal(business, '2026-05-26');
  });
});
