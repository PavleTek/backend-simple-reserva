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

  it('includes header, panel link and source label', () => {
    const html = buildNewReservationNotificationHtml(base);
    assert.ok(html.includes('NUEVA RESERVA'));
    assert.ok(html.includes('Reserva web'));
    assert.ok(html.includes(base.panelUrl));
  });

  it('lists reservation details from most to least important', () => {
    const html = buildNewReservationNotificationHtml(base);
    const fechaIdx = html.indexOf('Fecha');
    const horaIdx = html.indexOf('Hora');
    const comensalesIdx = html.indexOf('Comensales');
    const clienteIdx = html.indexOf('Cliente');
    const telefonoIdx = html.indexOf('Teléfono');
    const correoIdx = html.indexOf('Correo');
    const origenIdx = html.indexOf('Origen');
    assert.ok(fechaIdx < horaIdx);
    assert.ok(horaIdx < comensalesIdx);
    assert.ok(comensalesIdx < clienteIdx);
    assert.ok(clienteIdx < telefonoIdx);
    assert.ok(telefonoIdx < correoIdx);
    assert.ok(correoIdx < origenIdx);
  });

  it('omits phone row when phone is missing', () => {
    const html = buildNewReservationNotificationHtml({ ...base, customerPhone: null });
    assert.ok(!html.includes('Teléfono'));
  });
});
