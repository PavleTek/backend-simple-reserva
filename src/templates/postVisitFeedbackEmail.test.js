'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildPostVisitFeedbackHtml } = require('./postVisitFeedbackEmail');

describe('postVisitFeedbackEmail', () => {
  it('uses Chilean CTA and includes logo on HTTPS asset base', () => {
    const html = buildPostVisitFeedbackHtml({
      restaurantName: 'Nuevo Local',
      customerName: 'Juan',
      dateTime: new Date('2026-05-22T18:00:00Z'),
      clickUrl: 'https://dev.simplereserva.com/api/public/feedback/tok/click',
      optOutUrl: 'https://dev.simplereserva.com/api/public/feedback/tok/opt-out',
      assetBaseUrl: 'https://dev.simplereserva.com',
    });
    assert.ok(html.includes('Cuéntanos cómo fue'));
    assert.ok(!html.includes('Contanos'));
    assert.ok(html.includes('logo-full-480w.png'));
    assert.ok(html.includes('lang="es-CL"'));
    assert.ok(html.includes('Enviado por SimpleReserva para Nuevo Local.'));
    assert.ok(html.includes('&copy;'));
    assert.ok(html.includes('2026 SimpleReserva'));
    assert.ok(html.includes('SimpleReserva</p>'));
  });

  it('brands with restaurant logo and keeps SR in footer', () => {
    const html = buildPostVisitFeedbackHtml({
      restaurantName: 'Nuevo Local',
      customerName: 'Juan',
      dateTime: new Date('2026-05-22T18:00:00Z'),
      clickUrl: 'https://dev.simplereserva.com/api/public/feedback/tok/click',
      optOutUrl: 'https://dev.simplereserva.com/api/public/feedback/tok/opt-out',
      assetBaseUrl: 'https://dev.simplereserva.com',
      restaurantLogoUrl: 'https://cdn.example.com/nl.png',
      appearanceTheme: 'lavanda-clara',
    });
    assert.ok(html.includes('https://cdn.example.com/nl.png'));
    assert.ok(html.includes('#6b4c9a'));
    assert.ok(html.includes('width="120"'));
    assert.ok(html.includes('Enviado por SimpleReserva para Nuevo Local.'));
  });
});
