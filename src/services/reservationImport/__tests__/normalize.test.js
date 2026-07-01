'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDateStr,
  parseTimeStr,
  mapStatus,
  parsePartySize,
  durationFromEnd,
  normalizeEmail,
} = require('../normalize');

describe('reservationImport normalize', () => {
  it('parseDateStr accepts ISO and dd/MM/yyyy', () => {
    assert.equal(parseDateStr('2026-01-15'), '2026-01-15');
    assert.equal(parseDateStr('15/01/2026'), '2026-01-15');
  });

  it('parseTimeStr normalizes HH:mm', () => {
    assert.equal(parseTimeStr('9:30'), '09:30');
    assert.equal(parseTimeStr('19:30:00'), '19:30');
  });

  it('mapStatus maps Spanish aliases', () => {
    assert.equal(mapStatus('confirmada'), 'confirmed');
    assert.equal(mapStatus('cancelada'), 'cancelled');
    assert.equal(mapStatus('pendiente'), 'confirmed');
  });

  it('parsePartySize rejects invalid', () => {
    assert.equal(parsePartySize('4'), 4);
    assert.equal(parsePartySize('0'), null);
  });

  it('durationFromEnd computes minutes', () => {
    assert.equal(durationFromEnd('19:00', '21:00'), 120);
  });

  it('normalizeEmail lowercases valid email', () => {
    const r = normalizeEmail('Test@Example.CL');
    assert.equal(r.value, 'test@example.cl');
    assert.equal(r.invalid, false);
  });
});
