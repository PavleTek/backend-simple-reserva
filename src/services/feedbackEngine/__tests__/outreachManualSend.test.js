'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCanSendManual } = require('../feedbackEnqueue');

describe('resolveCanSendManual', () => {
  it('restaurante: no permite envío si no es elegible', () => {
    const r = resolveCanSendManual({
      eligible: false,
      email: 'a@b.com',
      surveyAnswered: false,
      skipReason: 'cooldown',
      forAdmin: false,
    });
    assert.equal(r.canSendManual, false);
  });

  it('admin: permite envío con cooldown u opt-out', () => {
    assert.equal(
      resolveCanSendManual({
        eligible: false,
        email: 'a@b.com',
        surveyAnswered: false,
        skipReason: 'cooldown',
        forAdmin: true,
      }).canSendManual,
      true,
    );
    assert.equal(
      resolveCanSendManual({
        eligible: false,
        email: 'a@b.com',
        surveyAnswered: false,
        skipReason: 'cooldown',
        forAdmin: true,
      }).adminOverrideSend,
      true,
    );
  });

  it('no permite si ya respondió la encuesta', () => {
    const r = resolveCanSendManual({
      eligible: true,
      email: 'a@b.com',
      surveyAnswered: true,
      skipReason: null,
      forAdmin: true,
    });
    assert.equal(r.canSendManual, false);
  });
});
