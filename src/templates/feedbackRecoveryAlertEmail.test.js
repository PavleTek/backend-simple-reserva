'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFeedbackRecoveryAlertHtml,
  getRecoveryAlertSubject,
} = require('./feedbackRecoveryAlertEmail');

describe('feedbackRecoveryAlertEmail', () => {
  it('plantilla concisa con contacto y CTA', () => {
    const html = buildFeedbackRecoveryAlertHtml({
      restaurantName: 'Nuevo Local',
      customerName: 'Matías Fuentes',
      overallScore: 1,
      comment: 'Como el orto eh',
      severity: 'high',
      panelUrl: 'https://app.example.com/experiencia',
      customerEmail: 'matias@example.com',
      customerPhone: '+56982618222',
      visitDateTime: new Date('2026-05-22T23:00:00Z'),
      partySize: 2,
      timezone: 'America/Santiago',
      recoveryContactRequested: true,
      recoveryContactEmail: 'matias@example.com',
      assetBaseUrl: 'https://dev.simplereserva.com',
    });
    assert.ok(html.includes('Matías Fuentes'));
    assert.ok(html.includes('1/5'));
    assert.ok(html.includes('Como el orto eh'));
    assert.ok(html.includes('mailto:matias@example.com'));
    assert.ok(html.includes('Abrir Experiencia'));
    assert.ok(html.includes('pidió que lo contacten'));
    assert.ok(html.includes('nota interna'));
    assert.ok(!html.includes('recovery'));
    assert.ok(!html.includes('¿Qué pasó?'));
    assert.ok(!html.includes('Qué puedes hacer ahora'));
    assert.ok(!html.includes('vista o resuelta'));
    assert.ok(html.includes('Enviado por SimpleReserva para Nuevo Local.'));
    assert.ok(html.includes('&copy;'));
    assert.ok(html.includes('2026 SimpleReserva'));
  });

  it('asunto corto con emoji de alerta', () => {
    const subject = getRecoveryAlertSubject({
      restaurantName: 'Nuevo Local',
      customerName: 'Matías Fuentes',
      overallScore: 1,
      severity: 'high',
    });
    assert.ok(subject.startsWith('🚨'));
    assert.ok(subject.includes('Matías Fuentes'));
    assert.ok(subject.includes('1/5'));
    assert.ok(subject.includes('Nuevo Local'));
    assert.ok(!subject.includes('Mala experiencia en'));
  });

  it('severidad media usa emoji de advertencia', () => {
    const subject = getRecoveryAlertSubject({
      restaurantName: 'Café',
      customerName: 'Ana',
      overallScore: 2,
      severity: 'medium',
    });
    assert.ok(subject.startsWith('⚠️'));
  });
});
