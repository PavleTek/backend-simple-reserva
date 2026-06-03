'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeLastInteractionAt } = require('../feedbackEnqueue');

const VISIT_DATE = new Date('2026-05-21T14:00:00Z');
const baseReservation = { dateTime: VISIT_DATE };

describe('computeLastInteractionAt', () => {
  it('devuelve la fecha de visita cuando no hay request', () => {
    const result = computeLastInteractionAt(baseReservation, null);
    assert.equal(result, VISIT_DATE.toISOString());
  });

  it('no sube por sentAt (envío saliente no es actividad del cliente)', () => {
    const laterSentAt = new Date(VISIT_DATE.getTime() + 2 * 60 * 60_000);
    const req = { sentAt: laterSentAt, updatedAt: laterSentAt, scheduledFor: laterSentAt };
    const result = computeLastInteractionAt(baseReservation, req);
    assert.equal(result, VISIT_DATE.toISOString());
  });

  it('sube por clickedAt (actividad del cliente)', () => {
    const clickAt = new Date(VISIT_DATE.getTime() + 3 * 60 * 60_000);
    const req = { clickedAt: clickAt };
    const result = computeLastInteractionAt(baseReservation, req);
    assert.equal(result, clickAt.toISOString());
  });

  it('sube por respondedAt (respuesta del cliente)', () => {
    const respondAt = new Date(VISIT_DATE.getTime() + 4 * 60 * 60_000);
    const req = { response: { respondedAt: respondAt } };
    const result = computeLastInteractionAt(baseReservation, req);
    assert.equal(result, respondAt.toISOString());
  });

  it('elige el mayor entre openedAt y clickedAt', () => {
    const openAt = new Date(VISIT_DATE.getTime() + 1 * 60 * 60_000);
    const clickAt = new Date(VISIT_DATE.getTime() + 2 * 60 * 60_000);
    const req = { openedAt: openAt, clickedAt: clickAt };
    const result = computeLastInteractionAt(baseReservation, req);
    assert.equal(result, clickAt.toISOString());
  });
});
