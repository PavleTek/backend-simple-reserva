'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNewReservationNotificationHtml,
  buildNewReservationSubject,
  buildNewReservationPreheader,
} = require('./newReservationNotificationEmail');

describe('buildNewReservationSubject', () => {
  it('prioritizes time, date, guest and party size for mobile preview', () => {
    const subject = buildNewReservationSubject({
      customerName: 'Juanito cliente',
      restaurantName: 'La Casona de Pedro',
      timeStr: '19:30',
      dateShort: 'hoy',
      partySize: 4,
    });
    assert.ok(subject.startsWith('📅'));
    assert.ok(subject.includes('19:30 hoy'));
    assert.ok(subject.includes('Juanito cliente'));
    assert.ok(subject.includes('4p'));
    assert.ok(subject.includes('La Casona de Pedro'));
    assert.ok(subject.length <= 65);
  });

  it('drops restaurant name when core subject already fills mobile preview', () => {
    const subject = buildNewReservationSubject({
      customerName: 'María González de los Andes',
      restaurantName: 'Restaurante con nombre muy largo para probar',
      timeStr: '14:30',
      dateShort: 'mañana',
      partySize: 8,
    });
    assert.ok(subject.includes('14:30 mañana'));
    assert.ok(subject.includes('8p'));
    assert.ok(!subject.includes('Restaurante'));
    assert.ok(subject.length <= 65);
  });
});

describe('buildNewReservationPreheader', () => {
  it('includes guests, source and phone for inbox snippet', () => {
    const preheader = buildNewReservationPreheader({
      partySize: 2,
      restaurantName: 'Café Demo',
      sourceLabel: 'Reserva web',
      customerPhone: '+56912345678',
    });
    assert.ok(preheader.includes('2 comensales'));
    assert.ok(preheader.includes('Reserva web'));
    assert.ok(preheader.includes('+56912345678'));
    assert.ok(preheader.includes('Ver en el panel'));
  });
});

describe('buildNewReservationNotificationHtml', () => {
  const base = {
    restaurantName: 'Café Demo',
    customerName: 'Ana',
    customerPhone: '+56912345678',
    customerEmail: 'ana@example.com',
    dateStr: '15/06/2026',
    timeStr: '19:30',
    dateShort: 'hoy',
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
    assert.ok(html.includes('19:30 · hoy'));
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
