'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { compressPdfBuffer } = require('./pdfCompressionService');

describe('compressPdfBuffer', () => {
  it('returns empty buffer for empty input without throwing', async () => {
    const result = await compressPdfBuffer(Buffer.alloc(0));
    assert.equal(result.originalBytes, 0);
    assert.equal(result.compressedBytes, 0);
    assert.equal(result.compressed, false);
    assert.equal(result.buffer.length, 0);
  });

  it('falls back to original for invalid PDF data', async () => {
    const invalid = Buffer.from('not a pdf');
    const result = await compressPdfBuffer(invalid);
    assert.equal(result.compressed, false);
    assert.equal(result.originalBytes, invalid.length);
    assert.equal(result.compressedBytes, invalid.length);
    assert.deepEqual(result.buffer, invalid);
  });

  it('compresses a minimal valid PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const original = Buffer.from(await doc.save());

    const result = await compressPdfBuffer(original);
    assert.equal(result.compressed, true);
    assert.equal(result.originalBytes, original.length);
    assert.ok(result.compressedBytes > 0);
    assert.ok(result.buffer.length > 0);
    assert.ok(result.compressedBytes <= result.originalBytes);
  });
});
