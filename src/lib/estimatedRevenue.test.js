'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { estimatedRevenue } = require('./estimatedRevenue');

describe('estimatedRevenue', () => {
  it('cubiertos × ticket', () => {
    assert.equal(estimatedRevenue(10, 25000), 250000);
  });

  it('sin ticket o ticket inválido → null', () => {
    assert.equal(estimatedRevenue(10, null), null);
    assert.equal(estimatedRevenue(10, 0), null);
    assert.equal(estimatedRevenue(10, -1), null);
  });
});
