'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldEnterGraceFromRejectedPayment,
  decideOverdueAutomaticSubAction,
} = require('./paymentFailureDetection');

test('shouldEnterGraceFromRejectedPayment: renovación fallida de sub activa → entra a gracia', () => {
  assert.equal(
    shouldEnterGraceFromRejectedPayment({
      activeSub: { status: 'active', billingStrategy: 'automatic_recurring', mercadopagoPreapprovalId: 'mp-1' },
      hasPendingCheckout: false,
    }),
    true,
  );
});

test('shouldEnterGraceFromRejectedPayment: hay checkout pendiente (upgrade/alta en curso) → no toca la sub sana', () => {
  assert.equal(
    shouldEnterGraceFromRejectedPayment({
      activeSub: { status: 'active', billingStrategy: 'automatic_recurring', mercadopagoPreapprovalId: 'mp-1' },
      hasPendingCheckout: true,
    }),
    false,
  );
});

test('shouldEnterGraceFromRejectedPayment: sin suscripción activa (aún en trial) → no aplica', () => {
  assert.equal(
    shouldEnterGraceFromRejectedPayment({
      activeSub: null,
      hasPendingCheckout: false,
    }),
    false,
  );
});

test('shouldEnterGraceFromRejectedPayment: sub activa en pago manual (Checkout Pro) → no aplica', () => {
  assert.equal(
    shouldEnterGraceFromRejectedPayment({
      activeSub: { status: 'active', billingStrategy: 'manual_monthly', mercadopagoPreapprovalId: null },
      hasPendingCheckout: false,
    }),
    false,
  );
});

test('shouldEnterGraceFromRejectedPayment: sub ya en gracia → no reintenta (status no es active)', () => {
  assert.equal(
    shouldEnterGraceFromRejectedPayment({
      activeSub: { status: 'grace', billingStrategy: 'automatic_recurring', mercadopagoPreapprovalId: 'mp-1' },
      hasPendingCheckout: false,
    }),
    false,
  );
});

test('decideOverdueAutomaticSubAction: authorized + periodo vencido + último cobro es previo al periodo vencido → enter_grace (caso Pilla la Vaca)', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'authorized',
      currentPeriodEnd: new Date('2026-06-29T12:00:00Z'),
      lastChargedDate: new Date('2026-05-29T12:00:05Z'),
      now,
    }),
    { action: 'enter_grace' },
  );
});

test('decideOverdueAutomaticSubAction: authorized + periodo vencido pero MP cobró DESPUÉS de ese periodo → sync_period_end (webhook perdido)', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'authorized',
      currentPeriodEnd: new Date('2026-06-29T12:00:00Z'),
      lastChargedDate: new Date('2026-06-29T12:05:00Z'),
      now,
    }),
    { action: 'sync_period_end' },
  );
});

test('decideOverdueAutomaticSubAction: periodo vencido hace <6h sin cobro nuevo → none (espera cobro MP; caso Localcin)', () => {
  const currentPeriodEnd = new Date('2026-07-29T03:16:04.967Z');
  const now = new Date('2026-07-29T04:00:00.000Z'); // ~44 min después
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'authorized',
      currentPeriodEnd,
      lastChargedDate: new Date('2026-06-29T03:16:04.967Z'),
      now,
    }),
    { action: 'none' },
  );
});

test('decideOverdueAutomaticSubAction: periodo vencido hace ≥6h sin cobro nuevo → enter_grace', () => {
  const currentPeriodEnd = new Date('2026-07-29T03:16:04.967Z');
  const now = new Date('2026-07-29T09:16:04.967Z'); // exactamente 6h
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'authorized',
      currentPeriodEnd,
      lastChargedDate: new Date('2026-06-29T03:16:04.967Z'),
      now,
    }),
    { action: 'enter_grace' },
  );
});

test('decideOverdueAutomaticSubAction: periodo aún vigente → none', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'authorized',
      currentPeriodEnd: new Date('2026-07-29T12:00:00Z'),
      lastChargedDate: null,
      now,
    }),
    { action: 'none' },
  );
});

test('decideOverdueAutomaticSubAction: MP dice cancelled/paused (no authorized) → none (lo maneja otra rama)', () => {
  assert.deepEqual(
    decideOverdueAutomaticSubAction({
      mpStatus: 'cancelled',
      currentPeriodEnd: new Date('2026-06-29T12:00:00Z'),
      lastChargedDate: null,
      now: new Date('2026-07-02T12:00:00Z'),
    }),
    { action: 'none' },
  );
});
