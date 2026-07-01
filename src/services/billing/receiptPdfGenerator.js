'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { resolveLogoImageUrl } = require('../../templates/reservationConfirmationEmail');

const LOGO_PATH = path.join(__dirname, '../../../assets/brand/logo-full-480w.png');

const BRAND = rgb(139 / 255, 45 / 255, 58 / 255);
const INK = rgb(28 / 255, 27 / 255, 23 / 255);
const MUTED = rgb(83 / 255, 81 / 255, 70 / 255);
const LINE = rgb(28 / 255, 27 / 255, 23 / 255, 0.12);
const PANEL = rgb(250 / 255, 249 / 255, 246 / 255);
const FOOTER_MUTED = rgb(138 / 255, 134 / 255, 117 / 255);

function formatPaymentDate(date) {
  return new Date(date).toLocaleDateString('es-CL', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Santiago',
  });
}

function formatAmount(amount, currency) {
  const value = Number(amount);
  if (currency === 'CLP') {
    return `$${Math.round(value).toLocaleString('es-CL')} CLP`;
  }
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency }).format(value);
}

function receiptNumber(receiptId) {
  return String(receiptId).slice(-8).toUpperCase();
}

function paymentStatusLabel(status) {
  if (status === 'approved') return 'Pagado';
  if (status === 'pending') return 'Pendiente';
  if (status === 'rejected' || status === 'cancelled') return 'Rechazado';
  return status ?? 'Pagado';
}

function receiptTypeLabel(receiptType) {
  return receiptType === 'factura' ? 'Factura' : 'Boleta';
}

function drawLine(page, x1, y1, x2, y2) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.75, color: LINE });
}

function loadLogoBytes() {
  try {
    return fs.readFileSync(LOGO_PATH);
  } catch {
    return null;
  }
}

function resolveReceiptLogoSrc() {
  const assetBaseUrl = (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'https://simplereserva.com'
  ).replace(/\/$/, '');
  const remoteUrl = resolveLogoImageUrl(assetBaseUrl);
  if (remoteUrl) return remoteUrl;
  const bytes = loadLogoBytes();
  if (!bytes) return null;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function buildReceiptLogoHtml() {
  const logoSrc = resolveReceiptLogoSrc();
  if (logoSrc) {
    return `<div class="logo"><img src="${logoSrc}" alt="SimpleReserva" width="200" height="auto" /></div>`;
  }
  return '<div class="logo fallback">SimpleReserva</div>';
}

function wrapLines(text, maxWidth, size, font) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const FOOTER_DISCLAIMER =
  'Este documento es un comprobante interno de pago. No reemplaza boleta ni factura electrónica emitida ante el SII.';
const FOOTER_CONTACT = 'SimpleReserva · simplereserva.cl · soporte@simplereserva.cl';
const FOOTER_BOTTOM_PAD = 48;

function drawPdfFooter(page, font, margin, contentWidth) {
  const disclaimerLines = wrapLines(FOOTER_DISCLAIMER, contentWidth, 9, font);
  const lineHeight = 14;
  const blockHeight = 22 + 9 + 4 + disclaimerLines.length * lineHeight;
  const separatorY = FOOTER_BOTTOM_PAD + blockHeight;

  drawLine(page, margin, separatorY, margin + contentWidth, separatorY);

  let y = separatorY - 22;
  page.drawText(FOOTER_CONTACT, { x: margin, y, size: 9, font, color: FOOTER_MUTED });
  y -= 4 + lineHeight;
  for (const line of disclaimerLines) {
    page.drawText(line, { x: margin, y, size: 9, font, color: FOOTER_MUTED });
    y -= lineHeight;
  }
}

function drawLabelValue(page, font, fontBold, x, y, label, value, opts = {}) {
  const labelSize = opts.labelSize ?? 8;
  const valueSize = opts.valueSize ?? 10;
  const width = opts.width ?? 240;

  page.drawText(label, { x, y, size: labelSize, font, color: MUTED });
  page.drawText(String(value), {
    x,
    y: y - 14,
    size: valueSize,
    font: opts.bold ? fontBold : font,
    color: INK,
    maxWidth: width,
    lineHeight: valueSize + 3,
  });
  return y - (opts.gap ?? 28);
}

/**
 * Genera PDF de recibo de pago (no boleta SII).
 */
async function generateReceiptPdf(receipt, organization, plan) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 48;
  const contentWidth = 595 - margin * 2;
  const folio = receiptNumber(receipt.id);
  const paidAt = formatPaymentDate(receipt.paymentDate);
  const amountText = formatAmount(receipt.amount, receipt.currency);
  const orgName = organization?.name ?? receipt.clientBusinessName ?? '—';
  const planName = plan?.name ?? 'Suscripción SimpleReserva';
  const docType = receiptTypeLabel(receipt.receiptType);
  const status = paymentStatusLabel(receipt.mercadopagoStatus);

  let y = 792;
  const logoBytes = loadLogoBytes();
  if (logoBytes) {
    const logoImage = await pdfDoc.embedPng(logoBytes);
    const logoWidth = 120;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    page.drawImage(logoImage, {
      x: (595 - logoWidth) / 2,
      y: y - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });
    y -= logoHeight + 14;
  } else {
    page.drawText('SimpleReserva', {
      x: (595 - fontBold.widthOfTextAtSize('SimpleReserva', 18)) / 2,
      y: y - 18,
      size: 18,
      font: fontBold,
      color: BRAND,
    });
    y -= 34;
  }

  const subtitle = 'Comprobante de pago';
  page.drawText(subtitle, {
    x: (595 - font.widthOfTextAtSize(subtitle, 11)) / 2,
    y,
    size: 11,
    font,
    color: MUTED,
  });
  y -= 22;
  drawLine(page, margin, y, margin + contentWidth, y);
  y -= 22;

  // Title block
  page.drawText('Comprobante interno de pago', { x: margin, y, size: 18, font: fontBold, color: INK });
  y -= 20;
  page.drawText(`N° ${folio} · ${paidAt}`, { x: margin, y, size: 10, font, color: MUTED });
  y -= 22;

  // Meta pills row
  page.drawRectangle({ x: margin, y: y - 18, width: 72, height: 22, color: PANEL, borderColor: LINE, borderWidth: 0.75 });
  page.drawText(docType, { x: margin + 10, y: y - 12, size: 9, font: fontBold, color: INK });
  page.drawRectangle({ x: margin + 82, y: y - 18, width: 72, height: 22, color: PANEL, borderColor: LINE, borderWidth: 0.75 });
  page.drawText(status, { x: margin + 92, y: y - 12, size: 9, font: fontBold, color: INK });
  y -= 34;

  drawLine(page, margin, y, margin + contentWidth, y);
  y -= 20;

  page.drawText('DATOS DEL CLIENTE', { x: margin, y, size: 8, font: fontBold, color: MUTED });
  y -= 18;
  y = drawLabelValue(page, font, fontBold, margin, y, 'Organización', orgName, { gap: 30 });
  if (receipt.clientName) {
    y = drawLabelValue(page, font, fontBold, margin, y, 'Contacto', receipt.clientName, { gap: 30 });
  }
  if (receipt.clientTaxId) {
    y = drawLabelValue(page, font, fontBold, margin, y, 'RUT', receipt.clientTaxId, { gap: 30 });
  }
  if (receipt.clientEmail) {
    y = drawLabelValue(page, font, fontBold, margin, y, 'Correo', receipt.clientEmail, { gap: 30, width: 420 });
  }

  y -= 6;
  drawLine(page, margin, y, margin + contentWidth, y);
  y -= 20;

  page.drawText('DETALLE DEL COBRO', { x: margin, y, size: 8, font: fontBold, color: MUTED });
  y -= 18;

  // Line item table header
  page.drawRectangle({ x: margin, y: y - 16, width: contentWidth, height: 24, color: PANEL });
  page.drawText('Descripción', { x: margin + 12, y: y - 8, size: 9, font: fontBold, color: MUTED });
  const amountHeader = 'Monto';
  page.drawText(amountHeader, {
    x: margin + contentWidth - 12 - fontBold.widthOfTextAtSize(amountHeader, 9),
    y: y - 8,
    size: 9,
    font: fontBold,
    color: MUTED,
  });
  y -= 34;

  const description = `Suscripción mensual — ${planName}`;
  page.drawText(description, { x: margin + 12, y, size: 10, font, color: INK, maxWidth: contentWidth - 140 });
  page.drawText(amountText, {
    x: margin + contentWidth - 12 - font.widthOfTextAtSize(amountText, 10),
    y,
    size: 10,
    font: fontBold,
    color: INK,
  });
  y -= 28;
  drawLine(page, margin, y, margin + contentWidth, y);
  y -= 14;

  // Total box
  page.drawRectangle({
    x: margin + contentWidth - 220,
    y: y - 42,
    width: 220,
    height: 52,
    color: PANEL,
    borderColor: LINE,
    borderWidth: 0.75,
  });
  page.drawText('Total pagado', { x: margin + contentWidth - 204, y: y - 14, size: 9, font, color: MUTED });
  page.drawText(amountText, {
    x: margin + contentWidth - 204,
    y: y - 32,
    size: 16,
    font: fontBold,
    color: BRAND,
  });
  y -= 58;

  drawLine(page, margin, y, margin + contentWidth, y);
  y -= 20;

  page.drawText('INFORMACIÓN DE PAGO', { x: margin, y, size: 8, font: fontBold, color: MUTED });
  y -= 16;
  y = drawLabelValue(page, font, fontBold, margin, y, 'Medio de pago', 'Mercado Pago', { gap: 30 });
  if (receipt.mercadopagoPaymentId) {
    y = drawLabelValue(page, font, fontBold, margin, y, 'Referencia Mercado Pago', receipt.mercadopagoPaymentId, {
      gap: 30,
      width: 420,
    });
  }

  drawPdfFooter(page, font, margin, contentWidth);

  return Buffer.from(await pdfDoc.save());
}

/**
 * HTML alternativo para vista previa en navegador.
 */
function generateReceiptHtml(receipt, organization, plan) {
  const folio = receiptNumber(receipt.id);
  const paidAt = formatPaymentDate(receipt.paymentDate);
  const amountText = formatAmount(receipt.amount, receipt.currency);
  const orgName = organization?.name ?? receipt.clientBusinessName ?? '—';
  const planName = plan?.name ?? 'Suscripción SimpleReserva';
  const docType = receiptTypeLabel(receipt.receiptType);
  const status = paymentStatusLabel(receipt.mercadopagoStatus);
  const mpRef = receipt.mercadopagoPaymentId ?? '—';
  const logoBlock = buildReceiptLogoHtml();

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Comprobante ${folio} — SimpleReserva</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 16px;
      background: #f3f1ec;
      color: #1c1b17;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      line-height: 1.5;
    }
    .sheet {
      max-width: 720px;
      margin: 0 auto;
      background: #fdfcfa;
      border: 1px solid rgba(28,27,23,.10);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 18px 48px rgba(28,27,23,.08);
    }
    .logo {
      padding: 28px 28px 8px;
      text-align: center;
      background: #faf9f6;
      border-bottom: 1px solid rgba(28,27,23,.08);
    }
    .logo img {
      display: inline-block;
      width: 200px;
      max-width: 100%;
      height: auto;
      border: 0;
    }
    .logo.fallback {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 1.375rem;
      font-weight: 700;
      color: #6e2330;
      letter-spacing: -0.02em;
    }
    .body { padding: 28px; }
    h1 {
      margin: 0 0 6px;
      font-size: 1.5rem;
      letter-spacing: -0.03em;
    }
    .meta { color: #535146; font-size: .875rem; margin-bottom: 20px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: #faf9f6;
      border: 1px solid rgba(28,27,23,.10);
      font-size: .75rem;
      font-weight: 600;
    }
    section + section { margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(28,27,23,.10); }
    .label {
      font-size: .6875rem;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: #8a8675;
      margin-bottom: 12px;
    }
    dl { margin: 0; display: grid; gap: 12px; }
    .row { display: grid; grid-template-columns: 140px 1fr; gap: 12px; }
    .row dt { color: #535146; font-size: .875rem; }
    .row dd { margin: 0; font-size: .9375rem; font-weight: 500; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: .9375rem;
    }
    thead th {
      text-align: left;
      font-size: .75rem;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: #8a8675;
      background: #faf9f6;
      padding: 10px 12px;
    }
    thead th:last-child, tbody td:last-child { text-align: right; }
    tbody td { padding: 14px 12px; border-top: 1px solid rgba(28,27,23,.08); }
    .total {
      margin-top: 16px;
      margin-left: auto;
      width: min(100%, 260px);
      padding: 16px 18px;
      border-radius: 12px;
      background: #faf9f6;
      border: 1px solid rgba(28,27,23,.10);
    }
    .total small { display: block; color: #535146; margin-bottom: 4px; }
    .total strong { font-size: 1.375rem; color: #8b2d3a; }
    .footer {
      padding: 18px 28px 24px;
      border-top: 1px solid rgba(28,27,23,.10);
      color: #8a8675;
      font-size: .75rem;
    }
    @media print {
      body { background: #fff; padding: 0; }
      .sheet { box-shadow: none; border: none; border-radius: 0; }
    }
  </style>
</head>
<body>
  <article class="sheet">
    ${logoBlock}
    <div class="body">
      <p class="meta" style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;font-size:.75rem;font-weight:700;color:#8a8675;">Comprobante de pago</p>
      <h1>Comprobante interno de pago</h1>
      <p class="meta">N° ${folio} · ${paidAt}</p>
      <div class="badges">
        <span class="badge">${docType}</span>
        <span class="badge">${status}</span>
      </div>

      <section>
        <div class="label">Datos del cliente</div>
        <dl>
          <div class="row"><dt>Organización</dt><dd>${orgName}</dd></div>
          ${receipt.clientName ? `<div class="row"><dt>Contacto</dt><dd>${receipt.clientName}</dd></div>` : ''}
          ${receipt.clientTaxId ? `<div class="row"><dt>RUT</dt><dd>${receipt.clientTaxId}</dd></div>` : ''}
          ${receipt.clientEmail ? `<div class="row"><dt>Correo</dt><dd>${receipt.clientEmail}</dd></div>` : ''}
        </dl>
      </section>

      <section>
        <div class="label">Detalle del cobro</div>
        <table>
          <thead>
            <tr><th>Descripción</th><th>Monto</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Suscripción mensual — ${planName}</td>
              <td>${amountText}</td>
            </tr>
          </tbody>
        </table>
        <div class="total">
          <small>Total pagado</small>
          <strong>${amountText}</strong>
        </div>
      </section>

      <section>
        <div class="label">Información de pago</div>
        <dl>
          <div class="row"><dt>Medio de pago</dt><dd>Mercado Pago</dd></div>
          <div class="row"><dt>Referencia MP</dt><dd style="font-family: ui-monospace, monospace; font-size: .875rem;">${mpRef}</dd></div>
        </dl>
      </section>
    </div>
    <footer class="footer">
      SimpleReserva · simplereserva.cl · soporte@simplereserva.cl<br>
      Este documento es un comprobante interno de pago. No reemplaza boleta ni factura electrónica emitida ante el SII.
    </footer>
  </article>
</body>
</html>`;
}

module.exports = {
  generateReceiptPdf,
  generateReceiptHtml,
  receiptNumber,
  formatPaymentDate,
  formatAmount,
  resolveReceiptLogoSrc,
  buildReceiptLogoHtml,
};
