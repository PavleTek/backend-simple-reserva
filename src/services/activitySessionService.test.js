'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  enumerateSessionDates,
  normalizeSessionTime,
  sessionSlotKey,
  resolveBulkSlotAction,
} = require('./activitySessionService');

describe('activitySessionService bulk helpers', () => {
  it('enumerateSessionDates incluye ambos extremos en zona horaria', () => {
    const dates = enumerateSessionDates('2026-06-10', '2026-06-12', 'America/Santiago');
    assert.deepEqual(dates, ['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('normalizeSessionTime acepta HH:mm flexibles', () => {
    assert.equal(normalizeSessionTime('9:00'), '09:00');
    assert.equal(normalizeSessionTime('930'), '09:30');
    assert.equal(normalizeSessionTime('12:00'), '12:00');
    assert.equal(normalizeSessionTime('25:00'), null);
  });

  it('sessionSlotKey es estable por fecha y hora', () => {
    assert.equal(sessionSlotKey('2026-06-11', '12:00'), '2026-06-11|12:00');
  });

  it('resolveBulkSlotAction solo omite sesiones SCHEDULED', () => {
    assert.equal(resolveBulkSlotAction({ status: 'SCHEDULED' }, true), 'skip');
    assert.equal(resolveBulkSlotAction({ status: 'COMPLETED' }, true), 'create');
    assert.equal(resolveBulkSlotAction({ status: 'CANCELLED' }, true), 'reactivate');
    assert.equal(resolveBulkSlotAction(null, true), 'create');
    assert.equal(resolveBulkSlotAction({ status: 'SCHEDULED' }, false), 'create');
  });
});
