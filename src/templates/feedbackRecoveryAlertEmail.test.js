'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFeedbackRecoveryAlertHtml,
  getRecoveryAlertSubject,
} = require('./feedbackRecoveryAlertEmail');

describe('feedbackRecoveryAlertEmail', () => {
  it('usa español claro, resumen del problema y enlace a SimpleReserva', () => {
    const html = buildFeedbackRecoveryAlertHtml({
      restaurantName: 'Nuevo Local',
      customerName: 'adadada222',
      overallScore: 1,
      comment: 'LOS ODIO',
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
    assert.ok(html.includes('Mala experiencia'));
    assert.ok(!html.includes('recovery'));
    assert.ok(!html.includes('Recovery'));
    assert.ok(html.includes('¿Qué pasó?'));
    assert.ok(html.includes('adadada222'));
    assert.ok(html.includes('1 de 5'));
    assert.ok(html.includes('href="https://dev.simplereserva.com"'));
    assert.ok(html.includes('Abrir Experiencia del local'));
    assert.ok(html.includes('lang="es-CL"'));
  });

  it('asunto descriptivo sin jerga en inglés', () => {
    const subject = getRecoveryAlertSubject({
      restaurantName: 'Nuevo Local',
      customerName: 'adadada222',
      overallScore: 1,
      severity: 'high',
    });
    assert.ok(subject.includes('Mala experiencia en Nuevo Local'));
    assert.ok(subject.includes('adadada222'));
    assert.ok(subject.includes('1 de 5'));
    assert.ok(!subject.includes('Alta'));
    assert.ok(!subject.includes('[Experiencia]'));
  });
});
