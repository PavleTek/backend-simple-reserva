'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  computeVisitEnd,
  computeScheduledFor,
  evaluateSendWindow,
} = require('../scheduling');

describe('scheduling', () => {
  it('computeVisitEnd adds duration', () => {
    const start = new Date('2026-05-20T20:00:00Z');
    const end = computeVisitEnd(start, 90);
    assert.equal(end.getTime() - start.getTime(), 90 * 60_000);
  });

  it('evaluateSendWindow 240 min accepts 3h late', () => {
    const scheduled = new Date('2026-05-20T22:15:00Z');
    const now = new Date(scheduled.getTime() + 3 * 60 * 60_000);
    const w = evaluateSendWindow(scheduled, 240, now);
    assert.equal(w.inWindow, true);
    assert.equal(w.expired, false);
  });

  it('evaluateSendWindow expires after 4h', () => {
    const scheduled = new Date('2026-05-20T22:15:00Z');
    const now = new Date(scheduled.getTime() + 5 * 60 * 60_000);
    const w = evaluateSendWindow(scheduled, 240, now);
    assert.equal(w.expired, true);
    assert.equal(w.inWindow, false);
  });

  it('computeScheduledFor applies delay', () => {
    const visitEnd = new Date('2026-05-20T21:30:00Z');
    const scheduled = computeScheduledFor(visitEnd, 75);
    assert.equal(scheduled.getTime() - visitEnd.getTime(), 75 * 60_000);
  });
});
