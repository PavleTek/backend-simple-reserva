'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRecoveryResolution, formatUserDisplayName } = require('../feedbackAlertResolve');

describe('feedbackAlertResolve', () => {
  it('formatUserDisplayName usa nombre o email', () => {
    assert.equal(formatUserDisplayName({ name: 'Ana', lastName: 'López', email: 'a@b.com' }), 'Ana López');
    assert.equal(formatUserDisplayName({ email: 'a@b.com' }), 'a@b.com');
  });

  it('formatRecoveryResolution solo con alerta resuelta y nota', () => {
    assert.equal(formatRecoveryResolution(null), null);
    assert.equal(
      formatRecoveryResolution({ status: 'open', resolutionNote: 'x' }),
      null,
    );
    const r = formatRecoveryResolution({
      status: 'resolved',
      resolutionNote: 'Llamamos al cliente',
      resolvedAt: new Date('2026-05-22T12:00:00Z'),
      resolvedByDisplayName: 'Pedro',
    });
    assert.equal(r.note, 'Llamamos al cliente');
    assert.equal(r.resolvedByName, 'Pedro');
  });
});
