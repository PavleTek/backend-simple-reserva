'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { analyzeCommentSeverity } = require('../commentSeverity');

describe('commentSeverity', () => {
  it('detects high severity hygiene keywords', () => {
    const r = analyzeCommentSeverity('había una cucaracha en la mesa');
    assert.equal(r.level, 'high');
    assert.ok(r.matchedKeywords.length > 0);
  });

  it('returns none for empty comment', () => {
    const r = analyzeCommentSeverity('');
    assert.equal(r.level, 'none');
  });

  it('detects medium wait complaints', () => {
    const r = analyzeCommentSeverity('demora enorme en el servicio');
    assert.equal(r.level, 'medium');
  });
});
