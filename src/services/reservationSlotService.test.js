'use strict';

/**
 * Tests migrados de reservationSlotService → slotEngine v3.
 * El servicio reservationSlotService.js fue eliminado en v3.
 * Estos tests validan las mismas funciones en slotEngine/grid.js y slotEngine/windows.js.
 *
 * Run: node --test src/services/reservationSlotService.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { alignToGrid, generateGrid } = require('./slotEngine/grid');
const { getReservationWindows, getOperatingWindows } = require('./slotEngine/windows');

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

describe('generateGrid (clock-aligned, reemplaza legacy y clock_aligned)', () => {
  it('open 12:30, interval 60, duration 60 — equivalente a legacy con duration=60', () => {
    const windows = getOperatingWindows(schedule1230, 'continuous');
    const slots = generateGrid(windows, 60, 60);
    const times = slots.map((s) => s.time);
    // Clock-aligned: primer múltiplo de 60 >= 750min (12:30) = 780min (13:00)
    assert.equal(times[0], '13:00');
    assert.equal(times[times.length - 1], '22:00');
  });

  it('open 12:30, interval 30, duration 90', () => {
    const windows = getOperatingWindows(schedule1230, 'continuous');
    const slots = generateGrid(windows, 30, 90);
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('12:30'));
    assert.ok(times.includes('13:00'));
    assert.equal(times[times.length - 1], '21:30');
  });
});

describe('getReservationWindows', () => {
  it('uses custom windows when mode=custom', () => {
    const custom = [{ startTime: '15:00', endTime: '19:00' }];
    const windows = getReservationWindows(schedule1230, 'continuous', 'custom', custom);
    assert.deepEqual(windows, [[900, 1140]]);
  });

  it('falls back to operating hours when mode=same_as_schedule', () => {
    const windows = getReservationWindows(schedule1230, 'continuous', 'same_as_schedule', []);
    assert.deepEqual(windows, [[750, 1380]]); // 12:30 → 23:00
  });
});
