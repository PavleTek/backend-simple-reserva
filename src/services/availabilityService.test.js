'use strict';

/**
 * Unit tests for availabilityService.computeAvailability().
 *
 * These tests exercise the pure, synchronous computeAvailability() function with
 * pre-built snapshots so no DB connection is required.
 *
 * Run: node --test src/services/availabilityService.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { computeAvailability } = require('./availabilityService');

// ─── helpers ─────────────────────────────────────────────────────────────────

const TZ = 'America/Santiago';

/**
 * Build a minimal snapshot for a day with:
 *  - one continuous schedule (12:00–22:00)
 *  - defaultSlotDurationMinutes = 60
 *  - no buffer, 60 min minimum notice
 *  - tables: T1 (cap 1-2), T2 (cap 2-4)
 *  - zone Z1 contains T1, zone Z2 contains T2
 *  - no blocked slots, no existing reservations
 *  - isToday = false (ignores notice cutoff by default)
 */
function baseSnapshot(overrides = {}) {
  return {
    date: '2099-06-15',
    timezone: TZ,
    isToday: false,
    serverNowUtc: new Date('2099-06-15T00:00:00Z').toISOString(),
    schedule: {
      dayOfWeek: 0,
      scheduleMode: 'continuous',
      openTime: '12:00',
      closeTime: '22:00',
      breakfastStartTime: null,
      breakfastEndTime: null,
      lunchStartTime: null,
      lunchEndTime: null,
      dinnerStartTime: null,
      dinnerEndTime: null,
    },
    defaults: {
      slotDurationMinutes: 60,
      bufferMinutesBetweenReservations: 0,
      minimumNoticeMinutes: 60,
      advanceBookingLimitDays: 30,
    },
    durationRules: [],
    tables: [
      { id: 'T1', zoneId: 'Z1', minCapacity: 1, maxCapacity: 2, sortOrder: 0, zoneSortOrder: 0 },
      { id: 'T2', zoneId: 'Z2', minCapacity: 2, maxCapacity: 4, sortOrder: 0, zoneSortOrder: 1 },
    ],
    zones: [
      { id: 'Z1', name: 'Salón', sortOrder: 0 },
      { id: 'Z2', name: 'Terraza', sortOrder: 1 },
    ],
    blockedSlots: [],
    reservations: [],
    ...overrides,
  };
}

// Convert "YYYY-MM-DD HH:mm" in America/Santiago to ISO UTC string for test data.
// Simple approach: we just use a fixed offset (-3h or -4h).
// For test data isolation we use a future date 2099-06-15 (winter in CL → UTC-4 = -240 min).
// 12:00 local = 16:00 UTC on that date.
function santiagoToUtc(dateStr, timeStr) {
  // America/Santiago in June is UTC-4 (no DST in southern winter)
  const [h, m] = timeStr.split(':').map(Number);
  const utcH = h + 4; // offset +4 to get UTC
  const utcTimeStr = `${String(utcH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${dateStr}T${utcTimeStr}:00.000Z`;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('computeAvailability', () => {
  describe('a) standard day — no conflicts', () => {
    it('returns all slots for a party that fits a table', () => {
      const result = computeAvailability(baseSnapshot(), { partySize: 1, zoneId: null });
      assert.ok(result.slots.length > 0, 'should have slots');
      assert.ok(result.slots.every((s) => s.available), 'all should be available');
      // 12:00 → 21:00 = 10 slots (last slot ends at 22:00)
      assert.strictEqual(result.slots.length, 10);
      assert.strictEqual(result.slots[0].time, '12:00');
      assert.strictEqual(result.slots[9].time, '21:00');
    });

    it('returns reason=no_tables when partySize fits no table', () => {
      const result = computeAvailability(baseSnapshot(), { partySize: 10, zoneId: null });
      assert.strictEqual(result.slots.length, 0);
      assert.strictEqual(result.reason, 'no_tables');
    });
  });

  describe('b) service_periods schedule', () => {
    it('generates slots only within each service window', () => {
      const sn = baseSnapshot({
        schedule: {
          dayOfWeek: 1,
          scheduleMode: 'service_periods',
          openTime: null,
          closeTime: null,
          breakfastStartTime: null,
          breakfastEndTime: null,
          lunchStartTime: '13:00',
          lunchEndTime: '15:00',
          dinnerStartTime: '20:00',
          dinnerEndTime: '22:00',
        },
      });
      const result = computeAvailability(sn, { partySize: 1, zoneId: null });
      // Lunch: 13:00, 14:00 (2 slots). Dinner: 20:00, 21:00 (2 slots). Total = 4
      assert.strictEqual(result.slots.length, 4);
      const times = result.slots.map((s) => s.time);
      assert.deepStrictEqual(times, ['13:00', '14:00', '20:00', '21:00']);
    });
  });

  describe('c) blocked slot overlap', () => {
    it('excludes slots that overlap a blocked range', () => {
      // Block 14:00–16:00 local (18:00–20:00 UTC in Santiago winter)
      const sn = baseSnapshot({
        blockedSlots: [
          {
            startUtc: santiagoToUtc('2099-06-15', '14:00'),
            endUtc: santiagoToUtc('2099-06-15', '16:00'),
          },
        ],
      });
      const result = computeAvailability(sn, { partySize: 1, zoneId: null });
      const times = result.slots.map((s) => s.time);
      assert.ok(!times.includes('14:00'), '14:00 should be blocked');
      assert.ok(!times.includes('15:00'), '15:00 should be blocked (overlaps with block end)');
      assert.ok(times.includes('12:00'), '12:00 should not be blocked');
      assert.ok(times.includes('16:00'), '16:00 should not be blocked');
    });
  });

  describe('d) buffer minutes between reservations', () => {
    it('marks a table as booked if its reservation + buffer overlaps the slot', () => {
      // T1 is reserved 12:00–13:00 + 30 min buffer = occupied until 13:30
      // So the 13:00 slot (13:00–14:00) should still be counted as T1 being booked
      const sn = baseSnapshot({
        defaults: {
          slotDurationMinutes: 60,
          bufferMinutesBetweenReservations: 30,
          minimumNoticeMinutes: 60,
          advanceBookingLimitDays: 30,
        },
        reservations: [
          {
            tableId: 'T1',
            startUtc: santiagoToUtc('2099-06-15', '12:00'),
            durationMinutes: 60,
          },
        ],
      });
      // party=1 fits only T1 → at 13:00, T1 is still in buffer (until 13:30) → no open tables
      const result = computeAvailability(sn, { partySize: 1, zoneId: null });
      const times = result.slots.map((s) => s.time);
      assert.ok(!times.includes('12:00'), '12:00 slot should be taken by existing reservation');
      assert.ok(!times.includes('13:00'), '13:00 should be within buffer window');
      assert.ok(times.includes('14:00'), '14:00 should be clear');
    });
  });

  describe('e) isToday + minimumNoticeMinutes', () => {
    it('drops slots that are within minimumNoticeMinutes of `now`', () => {
      // Server now = 2099-06-15 13:30 local (13:30+4=17:30 UTC)
      // minimumNoticeMinutes = 60 → earliest bookable = 14:30
      // So 12:00, 13:00, 14:00 should all be dropped (14:00 slot starts at 14:00 < 14:30)
      const sn = baseSnapshot({
        isToday: true,
        serverNowUtc: santiagoToUtc('2099-06-15', '13:30'),
      });
      const now = new Date(santiagoToUtc('2099-06-15', '13:30'));
      const result = computeAvailability(sn, { partySize: 1, zoneId: null, now });
      const times = result.slots.map((s) => s.time);
      assert.ok(!times.includes('12:00'), '12:00 should be past');
      assert.ok(!times.includes('13:00'), '13:00 should be past');
      assert.ok(!times.includes('14:00'), '14:00 < 14:30 cutoff');
      // 15:00 is >= 14:30 cutoff (actually: 15:00 >= 14:30 → included but the slot starts at 15:00)
      // Wait: 13:30 + 60 min = 14:30. A slot at 15:00 starts at >= 14:30 → included
      assert.ok(times.includes('15:00'), '15:00 should be available');
    });
  });

  describe('f) zone filter', () => {
    it('only shows slots for tables in the requested zone', () => {
      // party=2 fits both T1 (zone Z1) and T2 (zone Z2)
      // Reserve T1 at 12:00 → T1 busy, T2 still free in Z2
      const sn = baseSnapshot({
        reservations: [
          {
            tableId: 'T1',
            startUtc: santiagoToUtc('2099-06-15', '12:00'),
            durationMinutes: 60,
          },
        ],
      });

      // Without zone filter, 12:00 still appears (T2 is free)
      const resultAll = computeAvailability(sn, { partySize: 2, zoneId: null });
      assert.ok(
        resultAll.slots.find((s) => s.time === '12:00'),
        '12:00 available via T2 without zone filter'
      );

      // With zone filter Z1, only T1 counts → 12:00 is booked
      const resultZ1 = computeAvailability(sn, { partySize: 2, zoneId: 'Z1' });
      assert.ok(!resultZ1.slots.find((s) => s.time === '12:00'), '12:00 booked in Z1');

      // With zone filter Z2, T2 is free → 12:00 shows up
      const resultZ2 = computeAvailability(sn, { partySize: 2, zoneId: 'Z2' });
      assert.ok(resultZ2.slots.find((s) => s.time === '12:00'), '12:00 available in Z2');
    });
  });

  describe('g) party size fits no table', () => {
    it('returns reason=no_tables when no table can seat the party', () => {
      const result = computeAvailability(baseSnapshot(), { partySize: 5, zoneId: null });
      assert.strictEqual(result.reason, 'no_tables');
      assert.strictEqual(result.slots.length, 0);
    });
  });

  describe('h) no schedule', () => {
    it('returns reason=no_schedule when schedule is null', () => {
      const sn = baseSnapshot({ schedule: null });
      const result = computeAvailability(sn, { partySize: 2, zoneId: null });
      assert.strictEqual(result.reason, 'no_schedule');
      assert.strictEqual(result.slots.length, 0);
    });
  });

  describe('i) durationRules override default duration', () => {
    it('applies the matching rule to generate shorter slots', () => {
      const sn = baseSnapshot({
        durationRules: [
          { minPartySize: 1, maxPartySize: 2, durationMinutes: 30 },
        ],
      });
      const result = computeAvailability(sn, { partySize: 1, zoneId: null });
      // 12:00–22:00, 30 min slots = 20 slots
      assert.strictEqual(result.slots.length, 20);
      assert.strictEqual(result.slots[0].time, '12:00');
      assert.strictEqual(result.slots[1].time, '12:30');
    });
  });

  describe('j) availableTables count accuracy', () => {
    it('reports correct open table count per slot', () => {
      // Reserve T1 at 12:00, T2 free → party=2 at 12:00 sees 1 open table (T2)
      const sn = baseSnapshot({
        reservations: [
          {
            tableId: 'T1',
            startUtc: santiagoToUtc('2099-06-15', '12:00'),
            durationMinutes: 60,
          },
        ],
      });
      const result = computeAvailability(sn, { partySize: 2, zoneId: null });
      const slot12 = result.slots.find((s) => s.time === '12:00');
      assert.ok(slot12, '12:00 slot should exist');
      assert.strictEqual(slot12.availableTables, 1, 'only T2 available at 12:00');
    });
  });
});
