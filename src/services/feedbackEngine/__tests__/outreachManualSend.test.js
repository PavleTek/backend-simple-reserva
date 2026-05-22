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

  it('restaurante: no permite si el cliente rechazó encuestas', () => {
    const r = resolveCanSendManual({
      eligible: true,
      email: 'a@b.com',
      surveyAnswered: false,
      declinedSurveys: true,
      forAdmin: false,
    });
    assert.equal(r.canSendManual, false);
  });

  it('admin: siempre puede enviar con email (salvo encuesta ya respondida)', () => {
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
        skipReason: 'not_completed',
        forAdmin: true,
      }).canSendManual,
      true,
    );
    assert.equal(
      resolveCanSendManual({
        eligible: true,
        email: 'a@b.com',
        surveyAnswered: false,
        declinedSurveys: true,
        forAdmin: true,
      }).canSendManual,
      true,
    );
    assert.equal(
      resolveCanSendManual({
        eligible: true,
        email: 'a@b.com',
        surveyAnswered: false,
        declinedSurveys: true,
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
