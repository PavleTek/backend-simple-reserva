'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  lifecycleFieldsForStatus,
  resolveWalkInContact,
} = require('./reservationCapture');

describe('lifecycleFieldsForStatus', () => {
  const now = new Date('2026-08-14T15:00:00.000Z');

  it('confirmed→arrived escribe arrivedAt', () => {
    assert.deepEqual(lifecycleFieldsForStatus('arrived', now), { arrivedAt: now });
  });

  it('arrived→completed escribe completedAt', () => {
    assert.deepEqual(lifecycleFieldsForStatus('completed', now), { completedAt: now });
  });

  it('confirmed→cancelled escribe cancelledAt', () => {
    assert.deepEqual(lifecycleFieldsForStatus('cancelled', now), { cancelledAt: now });
  });

  it('no_show y confirmed no escriben timestamp', () => {
    assert.deepEqual(lifecycleFieldsForStatus('no_show', now), {});
    assert.deepEqual(lifecycleFieldsForStatus('confirmed', now), {});
  });
});

describe('resolveWalkInContact', () => {
  it('sin teléfono no persiste centinela', () => {
    const c = resolveWalkInContact({ name: '', phone: '' });
    assert.equal(c.customerName, 'Walk-in');
    assert.equal(c.customerPhone, null);
    assert.equal(c.isWalkIn, true);
  });

  it('centinela → null', () => {
    const c = resolveWalkInContact({ name: 'Walk-in', phone: '—' });
    assert.equal(c.customerPhone, null);
  });

  it('teléfono real se conserva normalizado', () => {
    const c = resolveWalkInContact({ name: 'Ana', phone: '9 1234 5678' });
    assert.equal(c.customerName, 'Ana');
    assert.equal(c.customerPhone, '+56912345678');
    assert.equal(c.isWalkIn, true);
  });
});
