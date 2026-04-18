'use strict';

/**
 * Regression test for the day-of-week timezone bug:
 * a restaurant closed on Saturdays (in its own timezone) was accepting Saturday
 * reservations because dateTime.getDay() on a UTC server returned the SERVER's
 * day-of-week instead of the restaurant's.
 *
 * Run: node --test src/utils/timezone.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getDayOfWeekInTimezone } = require('./timezone');

describe('getDayOfWeekInTimezone', () => {
  describe('from date string', () => {
    it('returns 6 (Saturday) for 2026-04-18 in America/Santiago', () => {
      // 2026-04-18 is a Saturday in any reasonable timezone
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-18', 'America/Santiago'), 6);
    });

    it('returns 0 (Sunday) for 2026-04-19 in America/Santiago', () => {
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-19', 'America/Santiago'), 0);
    });

    it('returns 5 (Friday) for 2026-04-17 in America/Santiago', () => {
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-17', 'America/Santiago'), 5);
    });

    it('returns the correct day for every day of a known week', () => {
      // 2026-04-13 = Monday … 2026-04-19 = Sunday
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-13', 'America/Santiago'), 1);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-14', 'America/Santiago'), 2);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-15', 'America/Santiago'), 3);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-16', 'America/Santiago'), 4);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-17', 'America/Santiago'), 5);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-18', 'America/Santiago'), 6);
      assert.strictEqual(getDayOfWeekInTimezone('2026-04-19', 'America/Santiago'), 0);
    });
  });

  describe('from JS Date (the bug scenario)', () => {
    it('returns Saturday (6) for the UTC moment that represents Saturday 00:00 in Santiago, even though Date.getDay() may report Friday', () => {
      // Saturday 2026-04-18 00:00 in America/Santiago (UTC-4 in April) = 2026-04-18T04:00:00Z
      const utcMoment = new Date('2026-04-18T04:00:00Z');
      assert.strictEqual(getDayOfWeekInTimezone(utcMoment, 'America/Santiago'), 6);
    });

    it('returns Saturday (6) for Saturday 23:00 in Santiago even when UTC has rolled to Sunday', () => {
      // Saturday 2026-04-18 23:00 Santiago = Sunday 2026-04-19 03:00 UTC
      const utcMoment = new Date('2026-04-19T03:00:00Z');
      assert.strictEqual(getDayOfWeekInTimezone(utcMoment, 'America/Santiago'), 6);
    });

    it('returns Sunday (0) for Sunday 02:00 in Santiago', () => {
      // Sunday 2026-04-19 02:00 Santiago = Sunday 2026-04-19 06:00 UTC
      const utcMoment = new Date('2026-04-19T06:00:00Z');
      assert.strictEqual(getDayOfWeekInTimezone(utcMoment, 'America/Santiago'), 0);
    });
  });

  describe('correctness across multiple timezones', () => {
    it('agrees on day-of-week regardless of input form for the same local date', () => {
      // 2026-04-18 (Saturday) in Buenos Aires (UTC-3) midnight = 2026-04-18T03:00Z
      const fromString = getDayOfWeekInTimezone('2026-04-18', 'America/Argentina/Buenos_Aires');
      const fromDate = getDayOfWeekInTimezone(
        new Date('2026-04-18T03:00:00Z'),
        'America/Argentina/Buenos_Aires'
      );
      assert.strictEqual(fromString, 6);
      assert.strictEqual(fromDate, 6);
    });
  });
});
