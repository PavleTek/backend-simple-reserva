'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  alignToGrid,
  generateTimeSlots,
  generateTimeSlotsLegacy,
  compareEngines,
  getReservationWindows,
} = require('./reservationSlotService');

const schedule1230 = {
  openTime: '12:30',
  closeTime: '23:00',
  breakfastStartTime: null,
  breakfastEndTime: null,
  lunchStartTime: null,
  lunchEndTime: null,
  dinnerStartTime: null,
  dinnerEndTime: null,
};

describe('alignToGrid', () => {
  it('keeps 12:30 on 30-min grid', () => {
    assert.equal(alignToGrid(12 * 60 + 30, 30), 12 * 60 + 30);
  });

  it('aligns 12:30 to 13:00 on 60-min grid', () => {
    assert.equal(alignToGrid(12 * 60 + 30, 60), 13 * 60);
  });
});

describe('generateTimeSlots legacy', () => {
  it('matches historical behavior: open 12:30, duration 60', () => {
    const windows = [[12 * 60 + 30, 23 * 60]];
    const slots = generateTimeSlotsLegacy(windows, 60);
    assert.deepEqual(
      slots.map((s) => s.time),
      ['12:30', '13:30', '14:30', '15:30', '16:30', '17:30', '18:30', '19:30', '20:30', '21:30']
    );
  });
});

describe('generateTimeSlots clock_aligned', () => {
  it('open 12:30, interval 30, duration 90', () => {
    const windows = [[12 * 60 + 30, 23 * 60]];
    const slots = generateTimeSlots({
      mode: 'clock_aligned',
      schedule: schedule1230,
      scheduleMode: 'continuous',
      intervalMinutes: 30,
      reservationDurationMinutes: 90,
    });
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('12:30'));
    assert.ok(times.includes('13:00'));
    assert.ok(!times.includes('13:30') || times.includes('13:00'));
    assert.equal(times[times.length - 1], '21:30');
  });

  it('open 12:30, interval 60 — first slot 13:00', () => {
    const slots = generateTimeSlots({
      mode: 'clock_aligned',
      schedule: schedule1230,
      scheduleMode: 'continuous',
      intervalMinutes: 60,
      reservationDurationMinutes: 60,
    });
    assert.equal(slots[0].time, '13:00');
    assert.ok(!slots.some((s) => s.time === '12:30'));
  });
});

describe('STRICT_END vs ALLOW_OVERFLOW', () => {
  const windows = [[15 * 60, 19 * 60]];

  it('STRICT_END: last start 17:30 for 90 min window ending 19:00', () => {
    const slots = generateTimeSlots({
      mode: 'clock_aligned',
      windows,
      intervalMinutes: 30,
      reservationDurationMinutes: 90,
      reservationEndPolicy: 'STRICT_END',
    });
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('17:30'));
    assert.ok(!times.includes('18:30'));
  });

  it('ALLOW_OVERFLOW: allows 18:30 start', () => {
    const slots = generateTimeSlots({
      mode: 'clock_aligned',
      windows,
      intervalMinutes: 30,
      reservationDurationMinutes: 90,
      reservationEndPolicy: 'ALLOW_OVERFLOW',
    });
    assert.ok(slots.some((s) => s.time === '18:30'));
  });
});

describe('service_periods gaps preserved', () => {
  const schedule = {
    openTime: '11:00',
    closeTime: '23:00',
    lunchStartTime: '12:00',
    lunchEndTime: '15:00',
    dinnerStartTime: '19:00',
    dinnerEndTime: '22:00',
    breakfastStartTime: null,
    breakfastEndTime: null,
  };

  it('does not generate slots in gap between lunch and dinner', () => {
    const windows = getReservationWindows(schedule, 'service_periods', 'same_as_schedule', []);
    const slots = generateTimeSlotsLegacy(windows, 60);
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('12:00'));
    assert.ok(times.includes('14:00'));
    assert.ok(times.includes('19:00'));
    assert.ok(!times.some((t) => t >= '15:00' && t < '19:00'));
  });
});

describe('compareEngines', () => {
  it('detects diff for 12:30 open with interval 60', () => {
    const result = compareEngines({
      schedule: schedule1230,
      scheduleMode: 'continuous',
      intervalMinutes: 60,
      reservationDurationMinutes: 60,
    });
    assert.equal(result.hasDiff, true);
    assert.ok(result.onlyLegacy.includes('12:30'));
    assert.ok(result.onlyClock.includes('13:00'));
  });
});
