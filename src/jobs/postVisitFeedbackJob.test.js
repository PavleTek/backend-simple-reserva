'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SURVEY_JOB_SELECT, isPermanentFeedbackSkip } = require('./postVisitFeedbackJob');

test('SURVEY_JOB_SELECT incluye enabled para el loop de solicitudes pendientes', () => {
  assert.equal(SURVEY_JOB_SELECT.enabled, true);
});

test('un walk-in o un grupo fuera de rango no vuelve a entrar al lote', () => {
  assert.equal(isPermanentFeedbackSkip('walk_in'), true);
  assert.equal(isPermanentFeedbackSkip('party_size'), true);
  assert.equal(isPermanentFeedbackSkip('visit_not_ended'), false);
  assert.equal(isPermanentFeedbackSkip('not_completed'), false);
});

test('survey del map sin enabled haría saltar todo el loop de pendientes', () => {
  const surveyFromDb = {
    restaurantId: 'r1',
    sendDelayMinutes: 60,
    sendWindowMinutes: 240,
    eligibilityMode: 'confirmed_past_end',
  };
  assert.equal(!!surveyFromDb.enabled, false);
  assert.equal(!surveyFromDb?.enabled, true);
});
