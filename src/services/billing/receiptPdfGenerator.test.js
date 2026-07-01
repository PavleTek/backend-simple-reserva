'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateReceiptPdf, generateReceiptHtml, receiptNumber } = require('./receiptPdfGenerator');

describe('receiptPdfGenerator', () => {
  const receipt = {
    id: 'clreceipt1234567890',
    amount: 1012,
    currency: 'CLP',
    paymentDate: new Date('2026-05-29T12:00:00.000Z'),
    receiptType: 'boleta',
    mercadopagoStatus: 'approved',
    mercadopagoPaymentId: '160682343537',
    clientName: 'María Test',
    clientEmail: 'maria@test.cl',
    clientTaxId: '12.345.678-9',
  };

  const organization = { name: 'Nuevo Localcin Org' };
  const plan = { name: 'A luquita la empanada' };

  it('generates a non-empty PDF buffer', async () => {
    const pdf = await generateReceiptPdf(receipt, organization, plan);
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 500);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  });

  it('generates HTML with receipt metadata', () => {
    const html = generateReceiptHtml(receipt, organization, plan);
    assert.match(html, /SimpleReserva/);
    assert.match(html, /logo-full-480w\.png|data:image\/png;base64,/);
    assert.match(html, new RegExp(receiptNumber(receipt.id)));
    assert.match(html, /Nuevo Localcin Org/);
    assert.match(html, /A luquita la empanada/);
    assert.match(html, /160682343537/);
    assert.doesNotMatch(html, /Estado MP/);
  });
});
