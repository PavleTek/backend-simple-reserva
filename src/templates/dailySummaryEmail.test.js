'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDailySummaryHtml,
  buildDailySummarySubject,
} = require('./dailySummaryEmail');

describe('buildDailySummarySubject', () => {
  it('singular for one reservation', () => {
    assert.match(buildDailySummarySubject(1, 'DoceTrece'), /1 reserva/);
  });

  it('plural for multiple', () => {
    assert.match(buildDailySummarySubject(3, 'Café'), /3 reservas/);
  });
});

describe('buildDailySummaryHtml', () => {
  it('includes restaurant name, CTA and HTML structure', () => {
    const html = buildDailySummaryHtml({
      restaurantName: 'DoceTrece Ñuñoa',
      count: 2,
      dateDisplay: '26/05/2026',
      firstTime: '13:00',
      panelUrl: 'https://portal.example.com/reservations?date=2026-05-26',
      reservations: [
        { time: '13:00', partySize: 2, customerName: 'Ana' },
        { time: '20:30', partySize: 4, customerName: 'Luis' },
      ],
      assetBaseUrl: 'http://localhost:5173',
    });
    assert.match(html, /DoceTrece/);
    assert.match(html, /Ver reservas del día/);
    assert.match(html, /portal\.example\.com/);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /13:00/);
    assert.doesNotMatch(html, /Ver todas:/);
  });

  it('escapes HTML in customer names', () => {
    const html = buildDailySummaryHtml({
      restaurantName: 'Test',
      count: 1,
      dateDisplay: '01/01/2026',
      panelUrl: 'https://example.com/reservations',
      reservations: [{ time: '12:00', partySize: 2, customerName: '<script>' }],
    });
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});
