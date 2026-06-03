'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugifyRestaurantName } = require('./restaurantSlug');

test('slugifyRestaurantName normaliza acentos y espacios', () => {
  assert.equal(slugifyRestaurantName('Nuevo Localcins'), 'nuevo-localcins');
  assert.equal(slugifyRestaurantName('  Café Ñandú  '), 'cafe-nandu');
});

test('slugifyRestaurantName usa fallback si queda vacío', () => {
  assert.equal(slugifyRestaurantName('!!!'), 'local');
});
