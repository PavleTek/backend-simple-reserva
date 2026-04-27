'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const {
  buildReservationConfirmationHtml,
  escapeHtml,
  resolveLogoImageUrl,
} = require('./reservationConfirmationEmail');

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    assert.strictEqual(escapeHtml('"quotes"'), '&quot;quotes&quot;');
    assert.strictEqual(escapeHtml("apostrophe's"), 'apostrophe&#39;s');
  });

  it('returns empty string for null/undefined', () => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
  });
});

describe('resolveLogoImageUrl', () => {
  it('returns HTTPS absolute URL for production origin', () => {
    assert.strictEqual(
      resolveLogoImageUrl('https://simplereserva.com'),
      'https://simplereserva.com/logo-full-480w.png'
    );
  });

  it('returns null for http', () => {
    assert.strictEqual(resolveLogoImageUrl('http://simplereserva.com'), null);
  });

  it('returns null for localhost', () => {
    assert.strictEqual(resolveLogoImageUrl('https://localhost:5173'), null);
  });
});

describe('buildReservationConfirmationHtml', () => {
  const base = {
    restaurantName: 'Café Demo',
    customerName: 'Ana',
    dateTime: new Date('2026-06-15T22:30:00.000Z'),
    partySize: 2,
    viewUrl: 'https://example.com/reservation/token123',
    assetBaseUrl: 'http://localhost:5173',
  };

  it('includes timezone-formatted date and time when timezone is set', () => {
    const tz = 'America/Santiago';
    const dt = new Date(base.dateTime);
    const expectedDate = formatDateDisplay(dt, tz);
    const expectedTime = formatTime(dt, tz);
    const html = buildReservationConfirmationHtml({ ...base, timezone: tz });
    assert.ok(html.includes(expectedDate), `expected date ${expectedDate}`);
    assert.ok(html.includes(expectedTime), `expected time ${expectedTime}`);
  });

  it('escapes customer name with angle brackets in body', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      customerName: '<img src=x onerror=alert(1)>',
      restaurantName: 'Resto',
    });
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  });

  it('escapes viewUrl in href', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      viewUrl: 'https://x.com/a?b=1&c=2',
    });
    assert.ok(html.includes('href="https://x.com/a?b=1&amp;c=2"'));
  });

  it('uses text fallback header when logo URL is not allowed', () => {
    const html = buildReservationConfirmationHtml(base);
    assert.ok(html.includes('SimpleReserva</td></tr>'));
    assert.ok(!html.includes('logo-full-480w.png'));
  });

  it('includes logo when assetBaseUrl is HTTPS and non-local', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
    });
    assert.ok(html.includes('https://simplereserva.com/logo-full-480w.png'));
  });
});
