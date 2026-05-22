'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeLastInteractionAt, sortOutreachRows } = require('../feedbackEnqueue');

describe('outreach sort by last interaction', () => {
  it('computeLastInteractionAt usa la fecha más reciente del flujo', () => {
    const reservation = { dateTime: new Date('2026-05-20T18:00:00Z') };
    const req = {
      sentAt: new Date('2026-05-21T10:00:00Z'),
      clickedAt: new Date('2026-05-22T12:00:00Z'),
      response: { respondedAt: new Date('2026-05-22T14:00:00Z') },
    };
    const at = computeLastInteractionAt(reservation, req);
    assert.equal(at, '2026-05-22T14:00:00.000Z');
  });

  it('admin: ordena por lastInteractionAt descendente', () => {
    const rows = [
      { lastInteractionAt: '2026-05-20T10:00:00.000Z', emailSent: false, eligible: true },
      { lastInteractionAt: '2026-05-22T14:00:00.000Z', emailSent: true, eligible: false },
      { lastInteractionAt: '2026-05-21T12:00:00.000Z', emailSent: false, eligible: false },
    ];
    sortOutreachRows(rows, { forAdmin: true });
    assert.deepEqual(
      rows.map((r) => r.lastInteractionAt),
      [
        '2026-05-22T14:00:00.000Z',
        '2026-05-21T12:00:00.000Z',
        '2026-05-20T10:00:00.000Z',
      ],
    );
  });
});
