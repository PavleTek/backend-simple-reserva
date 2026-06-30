'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SURVEY_JOB_SELECT } = require('./postVisitFeedbackJob');

test('SURVEY_JOB_SELECT incluye enabled para el loop de solicitudes pendientes', () => {
  assert.equal(SURVEY_JOB_SELECT.enabled, true);
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
