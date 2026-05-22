'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeSatisfactionIndex, computeFunnelRates } = require('../satisfactionIndex');

describe('satisfactionIndex', () => {
  it('computes index from 1-5 scores', () => {
    const r = computeSatisfactionIndex([5, 5, 4, 2, 1]);
    assert.equal(r.count, 5);
    assert.equal(r.promotersPct, 60);
    assert.equal(r.detractorsPct, 40);
    assert.equal(r.index, 20);
  });

  it('índice -40 con 5 respuestas (40% detractores, 0% promotores)', () => {
    const r = computeSatisfactionIndex([1, 2, 3, 3, 3]);
    assert.equal(r.count, 5);
    assert.equal(r.promotersPct, 0);
    assert.equal(r.detractorsPct, 40);
    assert.equal(r.index, -40);
  });

  it('computeFunnelRates', () => {
    const f = computeFunnelRates(100, 40, 20);
    assert.equal(f.clickRate, 40);
    assert.equal(f.responseRate, 20);
    assert.equal(f.completionAfterClick, 50);
  });
});
