'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInstagramUrl } = require('../instagramUrl');

describe('normalizeInstagramUrl', () => {
  it('devuelve null para vacío', () => {
    assert.equal(normalizeInstagramUrl(null), null);
    assert.equal(normalizeInstagramUrl('  '), null);
  });

  it('convierte @handle a URL de perfil', () => {
    assert.equal(
      normalizeInstagramUrl('@nuevo_local'),
      'https://www.instagram.com/nuevo_local/',
    );
  });

  it('convierte handle sin @', () => {
    assert.equal(
      normalizeInstagramUrl('nuevolocal'),
      'https://www.instagram.com/nuevolocal/',
    );
  });

  it('añade https a instagram.com sin protocolo', () => {
    assert.equal(
      normalizeInstagramUrl('instagram.com/nuevolocal'),
      'https://www.instagram.com/nuevolocal/',
    );
  });

  it('normaliza URL completa', () => {
    assert.equal(
      normalizeInstagramUrl('https://www.instagram.com/nuevolocal/?hl=es'),
      'https://www.instagram.com/nuevolocal/',
    );
  });

  it('rechaza dominios que no son Instagram', () => {
    assert.equal(normalizeInstagramUrl('https://google.com/nuevolocal'), null);
    assert.equal(normalizeInstagramUrl('síguenos en ig'), null);
  });
});
