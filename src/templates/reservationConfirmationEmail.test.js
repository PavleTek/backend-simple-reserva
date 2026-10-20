'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const {
  buildReservationConfirmationHtml,
  escapeHtml,
  resolveLogoImageUrl,
  resolveRestaurantLogoImageUrl,
} = require('./reservationConfirmationEmail');
const { resolveEmailTheme } = require('../constants/bookingThemes');

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

  it('returns white wordmark when variant is white', () => {
    assert.strictEqual(
      resolveLogoImageUrl('https://simplereserva.com', { variant: 'white' }),
      'https://simplereserva.com/logo-full-white-480w.png'
    );
  });

  it('returns null for http', () => {
    assert.strictEqual(resolveLogoImageUrl('http://simplereserva.com'), null);
  });

  it('returns null for localhost', () => {
    assert.strictEqual(resolveLogoImageUrl('https://localhost:5173'), null);
  });
});

describe('resolveRestaurantLogoImageUrl', () => {
  it('accepts absolute HTTPS logo', () => {
    assert.strictEqual(
      resolveRestaurantLogoImageUrl('https://cdn.example.com/logos/abc.png'),
      'https://cdn.example.com/logos/abc.png'
    );
  });

  it('rejects http and localhost', () => {
    assert.strictEqual(resolveRestaurantLogoImageUrl('http://cdn.example.com/x.png'), null);
    assert.strictEqual(resolveRestaurantLogoImageUrl('https://localhost/logo.png'), null);
  });

  it('rejects invalid values', () => {
    assert.strictEqual(resolveRestaurantLogoImageUrl(null), null);
    assert.strictEqual(resolveRestaurantLogoImageUrl('not-a-url'), null);
  });
});

describe('resolveEmailTheme', () => {
  it('returns dark tokens for carbon', () => {
    const theme = resolveEmailTheme('carbon');
    assert.equal(theme.isDark, true);
    assert.equal(theme.pageBg, '#111111');
    assert.equal(theme.primary, '#8a8a8a');
  });

  it('falls back to crema-calida for unknown id', () => {
    const theme = resolveEmailTheme('no-existe');
    assert.equal(theme.id, 'crema-calida');
    assert.equal(theme.isDark, false);
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

  it('includes SR wordmark when assetBaseUrl is HTTPS and non-local', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
    });
    assert.ok(html.includes('https://simplereserva.com/logo-full-480w.png'));
  });

  it('uses restaurant logo in header and SR mark in footer when branded', () => {
    const logo = 'https://cdn.example.com/resto-logo.png';
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
      restaurantLogoUrl: logo,
      appearanceTheme: 'terracota',
    });
    assert.ok(html.includes(logo));
    assert.ok(html.includes('alt="Café Demo"'));
    assert.ok(!html.includes('alt="SimpleReserva" width="200"'));
    assert.ok(html.includes('logo-full-480w.png'));
    assert.ok(html.includes('width="120"'));
    assert.ok(html.includes('Enviado por SimpleReserva para Café Demo.'));
    assert.ok(html.includes('#b85c38'));
  });

  it('applies dark theme colors and white SR footer mark when branded dark', () => {
    const logo = 'https://cdn.example.com/resto-logo.png';
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
      restaurantLogoUrl: logo,
      appearanceTheme: 'carbon',
    });
    assert.ok(html.includes('background-color:#111111'));
    assert.ok(html.includes('#f0f0f0'));
    assert.ok(html.includes('logo-full-white-480w.png'));
    assert.ok(html.includes(logo));
  });

  it('ignores appearanceTheme without restaurant logo (SR default colors)', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
      appearanceTheme: 'carbon',
    });
    assert.ok(html.includes('background-color:#faf9f6'));
    assert.ok(!html.includes('background-color:#111111'));
    assert.ok(html.includes('logo-full-480w.png'));
    assert.ok(!html.includes('logo-full-white-480w.png'));
    assert.ok(!html.includes('width="120"'));
  });

  it('falls back to SR layout when restaurant logo URL is invalid', () => {
    const html = buildReservationConfirmationHtml({
      ...base,
      assetBaseUrl: 'https://simplereserva.com',
      restaurantLogoUrl: 'http://insecure.example.com/logo.png',
      appearanceTheme: 'carbon',
    });
    assert.ok(html.includes('logo-full-480w.png'));
    assert.ok(html.includes('background-color:#faf9f6'));
  });
});
