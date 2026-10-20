const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseEmbedHost } = require('./embedHost');

describe('parseEmbedHost', () => {
  it('normaliza y rechaza basura', () => {
    assert.equal(parseEmbedHost('WWW.Mi-Local.cl.'), 'mi-local.cl');
    assert.equal(parseEmbedHost('localhost'), 'localhost');
    assert.equal(parseEmbedHost('no hay.cl'), null);
    assert.equal(parseEmbedHost('https://evil.com'), null);
    assert.equal(parseEmbedHost(''), null);
    assert.equal(parseEmbedHost(null), null);
  });
});
