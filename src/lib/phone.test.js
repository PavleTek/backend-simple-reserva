'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, isSentinelPhone } = require('./phone');

describe('normalizePhone', () => {
  it('unifica formatos chilenos a E.164', () => {
    assert.equal(normalizePhone('+56912345678'), '+56912345678');
    assert.equal(normalizePhone('9 1234 5678'), '+56912345678');
    assert.equal(normalizePhone('56912345678'), '+56912345678');
    assert.equal(normalizePhone('+56 9 1234 5678'), '+56912345678');
  });

  it('centinelas y basura → null', () => {
    assert.equal(normalizePhone('—'), null);
    assert.equal(normalizePhone('-'), null);
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone('   '), null);
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone('abc'), null);
    assert.equal(isSentinelPhone('—'), true);
  });

  it('no asume +56 si el país no es CL', () => {
    assert.equal(normalizePhone('912345678', { defaultCountry: 'AR' }), null);
    assert.equal(normalizePhone('+5491112345678', { defaultCountry: 'AR' }), '+5491112345678');
  });
});
