'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNewReservationNotificationHtml,
  buildNewReservationSubject,
} = require('./newReservationNotificationEmail');

describe('buildNewReservationSubject', () => {
  it('includes customer and restaurant names', () => {
    assert.strictEqual(
      buildNewReservationSubject('Ana', 'Café Demo'),
      'Nueva reserva: Ana · Café Demo',
    );
  });
});

describe('buildNewReservationNotificationHtml', () => {
  const base = {
    restaurantName: 'Café Demo',
    customerName: 'Ana',
    customerPhone: '+56912345678',
    customerEmail: 'ana@example.com',
    dateStr: 'lunes 15 de junio',
    timeStr: '19:30',
    partySize: 4,
    panelUrl: 'https://panel.example.com/reservations?date=2026-06-15',
    sourceLabel: 'Reserva web',
    assetBaseUrl: 'https://simplereserva.com',
  };

  it('escapes customer name with HTML', () => {
    const html = buildNewReservationNotificationHtml({
      ...base,
      customerName: '<script>alert(1)</script>',
    });
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  });

  it('includes reservation details and panel link', () => {
    const html = buildNewReservationNotificationHtml(base);
    assert.ok(html.includes('NUEVA RESERVA'));
    assert.ok(html.includes('Reserva web'));
    assert.ok(html.includes('ana@example.com'));
    assert.ok(html.includes(base.panelUrl));
  });

  it('omits phone row when phone is missing', () => {
    const html = buildNewReservationNotificationHtml({ ...base, customerPhone: null });
    assert.ok(!html.includes('Teléfono'));
  });
});
