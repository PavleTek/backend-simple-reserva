'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isNoticeOpen,
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

test('excludeHeldOrganizations: el job de gracia no corta las cuentas con aviso', () => {
  const where = { status: 'cancelled', isActiveSubscription: true };
  assert.deepEqual(excludeHeldOrganizations(where, []), where);
  assert.deepEqual(excludeHeldOrganizations(where, ['org-pilla']), {
    status: 'cancelled',
    isActiveSubscription: true,
    organizationId: { notIn: ['org-pilla'] },
  });
});
