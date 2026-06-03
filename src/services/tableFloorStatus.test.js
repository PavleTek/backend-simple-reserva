'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeTableFloorStatus } = require('./tableFloorStatus');

describe('computeTableFloorStatus', () => {
  const now = new Date('2026-06-01T20:00:00.000Z');

  it('marks reserved_soon when next reservation is within 60 minutes', () => {
    const in30 = new Date(now.getTime() + 30 * 60000);
    const result = computeTableFloorStatus(
      [
        {
          id: 'r1',
          status: 'confirmed',
          dateTime: in30,
          durationMinutes: 90,
          customerName: 'Ana',
          partySize: 2,
        },
      ],
      now,
    );
    assert.equal(result.status, 'reserved_soon');
    assert.ok(result.nextReservation);
  });

  it('marks upcoming when next reservation is more than 60 minutes away', () => {
    const in90 = new Date(now.getTime() + 90 * 60000);
    const result = computeTableFloorStatus(
      [
        {
          id: 'r1',
          status: 'confirmed',
          dateTime: in90,
          durationMinutes: 90,
          customerName: 'Ana',
          partySize: 2,
        },
      ],
      now,
    );
    assert.equal(result.status, 'upcoming');
  });

  it('marks late_arrival after grace when confirmed and past start', () => {
    const started = new Date(now.getTime() - 15 * 60000);
    const result = computeTableFloorStatus(
      [
        {
          id: 'r1',
          status: 'confirmed',
          dateTime: started,
          durationMinutes: 90,
          customerName: 'Ana',
          partySize: 2,
        },
      ],
      now,
    );
    assert.equal(result.status, 'late_arrival');
  });

  it('reserved_soon with arrived walk-in and next confirmed within 60 min on same table', () => {
    const now = new Date('2026-06-01T22:30:00.000Z');
    const result = computeTableFloorStatus(
      [
        {
          id: 'walk',
          status: 'arrived',
          dateTime: new Date('2026-06-01T22:00:00.000Z'),
          durationMinutes: 60,
          customerName: 'Walk-in',
          partySize: 2,
          notes: 'walk-in',
        },
        {
          id: 'next',
          status: 'confirmed',
          dateTime: new Date('2026-06-01T23:00:00.000Z'),
          durationMinutes: 60,
          customerName: 'alberto',
          partySize: 2,
        },
      ],
      now,
    );
    assert.equal(result.status, 'reserved_soon');
    assert.equal(result.currentReservation?.customerName, 'Walk-in');
    assert.equal(result.nextReservation?.customerName, 'alberto');
  });

  it('occupied when arrived walk-in and next reservation is over 60 min away', () => {
    const now = new Date('2026-06-01T22:00:00.000Z');
    const result = computeTableFloorStatus(
      [
        {
          id: 'walk',
          status: 'arrived',
          dateTime: new Date('2026-06-01T22:00:00.000Z'),
          durationMinutes: 60,
          customerName: 'Walk-in',
          partySize: 2,
          notes: 'walk-in',
        },
        {
          id: 'next',
          status: 'confirmed',
          dateTime: new Date('2026-06-01T23:30:00.000Z'),
          durationMinutes: 60,
          customerName: 'alberto',
          partySize: 2,
        },
      ],
      now,
    );
    assert.equal(result.status, 'occupied');
    assert.ok(result.nextReservation);
  });
});
