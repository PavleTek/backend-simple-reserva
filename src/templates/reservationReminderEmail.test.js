'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReservationReminderHtml,
  buildReservationReminderSubject,
} = require('./reservationReminderEmail');

describe('buildReservationReminderSubject', () => {
  it('includes time and restaurant', () => {
    const subject = buildReservationReminderSubject('DoceTrece', '21:00');
    assert.equal(subject, 'Recordatorio: mañana a las 21:00 en DoceTrece');
  });
});

describe('buildReservationReminderHtml', () => {
  it('includes guest details and CTA', () => {
    const html = buildReservationReminderHtml({
      restaurantName: 'DoceTrece',
      customerName: 'María González',
      dateTime: new Date('2026-05-30T01:00:00.000Z'),
      partySize: 4,
      viewUrl: 'https://simplereserva.com/reservation/token123',
      timezone: 'America/Santiago',
      assetBaseUrl: 'https://simplereserva.com',
    });
    assert.match(html, /Tu reserva es mañana/);
    assert.match(html, /María González/);
    assert.match(html, /DoceTrece/);
    assert.match(html, /Ver o cancelar reserva/);
    assert.match(html, /token123/);
  });

  it('uses restaurant logo and theme when branded', () => {
    const html = buildReservationReminderHtml({
      restaurantName: 'DoceTrece',
      customerName: 'María',
      dateTime: new Date('2026-05-30T01:00:00.000Z'),
      partySize: 2,
      viewUrl: 'https://simplereserva.com/reservation/token123',
      assetBaseUrl: 'https://simplereserva.com',
      restaurantLogoUrl: 'https://cdn.example.com/logo.png',
      appearanceTheme: 'verde-bosque',
    });
    assert.match(html, /cdn\.example\.com\/logo\.png/);
    assert.match(html, /#3d8b6e/);
    assert.match(html, /logo-full-white-480w\.png/);
  });
});
