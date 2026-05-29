'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/**
 * Genera PDF de recibo de pago (no boleta SII).
 */
async function generateReceiptPdf(receipt, organization, plan) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 780;
  const draw = (text, opts = {}) => {
    const size = opts.size ?? 11;
    const f = opts.bold ? fontBold : font;
    page.drawText(String(text), { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    y -= opts.gap ?? 18;
  };

  draw('SimpleReserva', { size: 20, bold: true, gap: 28 });
  draw('Comprobante de pago', { size: 14, bold: true, gap: 24 });
  draw(`Organización: ${organization?.name ?? '—'}`);
  draw(`Plan: ${plan?.name ?? '—'}`);
  draw(`Fecha: ${new Date(receipt.paymentDate).toLocaleDateString('es-CL')}`);
  draw(`Monto: $${Number(receipt.amount).toLocaleString('es-CL')} ${receipt.currency}`);
  draw(`Tipo: ${receipt.receiptType === 'factura' ? 'Factura' : 'Boleta'}`);
  draw(`Estado MP: ${receipt.mercadopagoStatus ?? 'approved'}`);
  if (receipt.mercadopagoPaymentId) {
    draw(`ID pago MP: ${receipt.mercadopagoPaymentId}`);
  }
  y -= 10;
  draw('Este documento es un comprobante interno. No reemplaza boleta/factura electrónica SII.', {
    size: 9,
    gap: 14,
  });

  return Buffer.from(await pdfDoc.save());
}

/**
 * HTML alternativo para descarga en navegador.
 */
function generateReceiptHtml(receipt, organization, plan) {
  const date = new Date(receipt.paymentDate).toLocaleDateString('es-CL');
  const amount = Number(receipt.amount).toLocaleString('es-CL');
  return `<!DOCTYPE html><html lang="es-CL"><head><meta charset="utf-8"><title>Recibo ${receipt.id}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;color:#111}
h1{font-size:1.25rem}table{width:100%;border-collapse:collapse;margin-top:16px}td{padding:8px 0;border-bottom:1px solid #eee}
.footer{margin-top:32px;font-size:0.85rem;color:#666}</style></head><body>
<h1>Comprobante de pago — SimpleReserva</h1>
<table><tr><td>Organización</td><td>${organization?.name ?? '—'}</td></tr>
<tr><td>Plan</td><td>${plan?.name ?? '—'}</td></tr>
<tr><td>Fecha</td><td>${date}</td></tr>
<tr><td>Monto</td><td>$${amount} ${receipt.currency}</td></tr>
<tr><td>Tipo</td><td>${receipt.receiptType}</td></tr>
<tr><td>ID Mercado Pago</td><td>${receipt.mercadopagoPaymentId ?? '—'}</td></tr></table>
<p class="footer">Comprobante interno. No reemplaza documento tributario electrónico SII.</p></body></html>`;
}

module.exports = {
  generateReceiptPdf,
  generateReceiptHtml,
};
