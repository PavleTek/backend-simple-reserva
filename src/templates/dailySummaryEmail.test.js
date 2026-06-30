'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDailySummaryHtml,
  buildDailySummarySubject,
} = require('./dailySummaryEmail');

describe('buildDailySummarySubject', () => {
  it('uses clear Hoy prefix with restaurant and time', () => {
    const subject = buildDailySummarySubject(1, 'DoceTrece', '21:00', 4);
    assert.match(subject, /^Hoy: 1 reserva · 21:00 · 4 comensales · DoceTrece$/);
    assert.doesNotMatch(subject, /SimpleReserva:/);
  });

  it('plural for multiple reservations', () => {
    assert.match(buildDailySummarySubject(3, 'Café', null, 10), /3 reservas · 10 comensales/);
  });
});

describe('buildDailySummaryHtml', () => {
  it('includes restaurant name, stats, table and CTA', () => {
    const html = buildDailySummaryHtml({
      restaurantName: 'DoceTrece Ñuñoa',
      count: 2,
      dateDisplay: '26 may 2026',
      firstTime: '13:00',
      panelUrl: 'https://portal.example.com/reservations?date=2026-05-26',
      recipientName: 'María López',
      reservations: [
        { time: '13:00', partySize: 2, customerName: 'Ana' },
        { time: '20:30', partySize: 4, customerName: 'Luis' },
      ],
      assetBaseUrl: 'http://localhost:5173',
    });
    assert.match(html, /DoceTrece/);
    assert.match(html, /Hola María/);
    assert.match(html, /6 comensales/);
    assert.match(html, /Abrir reservas de hoy/);
    assert.match(html, /portal\.example\.com/);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /13:00/);
    assert.match(html, /notificaciones de reservas/);
  });

  it('shows table and notes when provided', () => {
    const html = buildDailySummaryHtml({
      restaurantName: 'Test',
      count: 1,
      dateDisplay: '24 jun 2026',
      panelUrl: 'https://example.com/reservations',
      reservations: [{
        time: '21:00',
        partySize: 4,
        customerName: 'María',
        tableLabel: 'Mesa 12',
        notes: 'Cumpleaños, traen torta',
      }],
    });
    assert.match(html, /Mesa 12/);
    assert.match(html, /Nota: Cumpleaños/);
  });

  it('escapes HTML in customer names', () => {
    const html = buildDailySummaryHtml({
      restaurantName: 'Test',
      count: 1,
      dateDisplay: '01 ene 2026',
      panelUrl: 'https://example.com/reservations',
      reservations: [{ time: '12:00', partySize: 2, customerName: '<script>' }],
    });
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});
