'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isNoticeOpen,
  isAccessHeld,
  resolveAccessUntil,
  accessRestorePatch,
  excludeHeldOrganizations,
} = require('./paymentRegularizationService');

test('isNoticeOpen: activo y sin resolver', () => {
  assert.equal(isNoticeOpen({ enabled: true, resolvedAt: null }), true);
  assert.equal(isNoticeOpen({ enabled: false, resolvedAt: null }), false);
  assert.equal(isNoticeOpen({ enabled: true, resolvedAt: new Date() }), false);
  assert.equal(isNoticeOpen(null), false);
});

test('accessRestorePatch: suscripción vencida vuelve a cancelled con acceso', () => {
  assert.deepEqual(
    accessRestorePatch({ isActiveSubscription: false, status: 'expired' }),
    { isActiveSubscription: true, status: 'cancelled' },
  );
});

test('accessRestorePatch: cancelled sin acceso solo prende el flag', () => {
  assert.deepEqual(
    accessRestorePatch({ isActiveSubscription: false, status: 'cancelled' }),
    { isActiveSubscription: true },
  );
});

test('accessRestorePatch: no toca una suscripción que ya tiene acceso', () => {
  assert.equal(
    accessRestorePatch({ isActiveSubscription: true, status: 'cancelled' }),
    null,
  );
  assert.equal(
    accessRestorePatch({ isActiveSubscription: true, status: 'active' }),
    null,
  );
});

test('isAccessHeld: solo mientras la fecha límite es futura', () => {
  const now = new Date('2026-10-20T15:00:00.000Z');
  const open = { enabled: true, resolvedAt: null };
  assert.equal(isAccessHeld({ ...open, accessUntil: new Date('2026-10-25T02:59:59.000Z') }, now), true);
  assert.equal(isAccessHeld({ ...open, accessUntil: new Date('2026-10-09T20:49:09.000Z') }, now), false);
  assert.equal(isAccessHeld({ ...open, accessUntil: null }, now), false);
  assert.equal(isAccessHeld({ enabled: false, resolvedAt: null, accessUntil: new Date('2026-10-25T02:59:59.000Z') }, now), false);
});

test('resolveAccessUntil: sin fecha da 7 días; una fecha pasada no sirve', () => {
  const now = new Date('2026-10-20T15:00:00.000Z');
  assert.equal(resolveAccessUntil(null, now).toISOString(), '2026-10-27T15:00:00.000Z');
  assert.equal(resolveAccessUntil('', now).toISOString(), '2026-10-27T15:00:00.000Z');
  assert.equal(resolveAccessUntil('2026-10-25T02:59:59.000Z', now).toISOString(), '2026-10-25T02:59:59.000Z');
  assert.equal(resolveAccessUntil('2026-10-01T00:00:00.000Z', now), null);
});

test('excludeHeldOrganizations: el job de gracia no corta las cuentas con aviso', () => {
  const where = { status: 'cancelled', isActiveSubscription: true };
  assert.deepEqual(excludeHeldOrganizations(where, []), where);
  assert.deepEqual(excludeHeldOrganizations(where, ['org-pilla']), {
    status: 'cancelled',
    isActiveSubscription: true,
    organizationId: { notIn: ['org-pilla'] },
  });
});
