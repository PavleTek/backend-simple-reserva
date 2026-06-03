'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

function buildPaymentApprovedSubject(restaurantName) {
  return `Pago confirmado — ${restaurantName}`;
}

function buildPaymentApprovedHtml({ restaurantName, planName, amountCLP, currency, panelUrl, assetBaseUrl = '' }) {
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Confirmamos tu pago de <strong>$${escapeHtml(String(amountCLP))} ${escapeHtml(currency)}</strong>
      por el plan <strong>${escapeHtml(planName)}</strong> de
      <strong>${escapeHtml(restaurantName)}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Adjuntamos el comprobante de pago. Puedes descargar tus recibos en cualquier momento desde facturación.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ver facturación</a>
      </td></tr>
    </table>`;

  const preheader = `Pago confirmado por ${planName}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Pago confirmado',
    preheader,
  });

  return wrapEmailDocument({
    title: buildPaymentApprovedSubject(restaurantName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildPaymentApprovedSubject,
  buildPaymentApprovedHtml,
};
