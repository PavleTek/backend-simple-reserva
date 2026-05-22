'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFeedbackRecoveryAlertHtml,
  getRecoveryAlertSubject,
} = require('./feedbackRecoveryAlertEmail');

describe('feedbackRecoveryAlertEmail', () => {
  it('incluye logo, contacto y CTA en plantilla HTML', () => {
    const html = buildFeedbackRecoveryAlertHtml({
      restaurantName: 'Nuevo Local',
      customerName: 'ssss',
      overallScore: 1,
      comment: 'd',
      severity: 'high',
      panelUrl: 'https://app.example.com/experiencia',
      customerEmail: 'cliente@example.com',
      customerPhone: '+56 9 1234 5678',
      visitDateTime: new Date('2026-05-20T20:00:00Z'),
      partySize: 2,
      timezone: 'America/Santiago',
      recoveryContactRequested: true,
      recoveryContactEmail: 'vgdev14@gmail.com',
      assetBaseUrl: 'https://dev.simplereserva.com',
    });
    assert.ok(html.includes('logo-full-480w.png'));
    assert.ok(html.includes('mailto:cliente@example.com'));
    assert.ok(html.includes('vgdev14@gmail.com'));
    assert.ok(html.includes('pidió que lo contacten'));
    assert.ok(html.includes('Ver en Experiencia'));
    assert.ok(html.includes('lang="es-CL"'));
  });

  it('arma asunto con severidad y puntuación', () => {
    const subject = getRecoveryAlertSubject({
      restaurantName: 'Nuevo Local',
      customerName: 'ssss',
      overallScore: 1,
      severity: 'high',
    });
    assert.ok(subject.includes('Alta'));
    assert.ok(subject.includes('ssss'));
    assert.ok(subject.includes('1/5'));
  });
});
