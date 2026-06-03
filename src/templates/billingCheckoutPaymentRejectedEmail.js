'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

/**
 * @param {string} orgName
 * @returns {string}
 */
function buildCheckoutPaymentRejectedSubject(orgName) {
  return `No pudimos procesar tu pago — ${orgName}`;
}

/**
 * @param {Object} options
 * @param {string} options.orgName
 * @param {string} options.ownerMessage
 * @param {string} options.panelUrl
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildCheckoutPaymentRejectedHtml(options) {
  const { orgName, ownerMessage, panelUrl, assetBaseUrl = '' } = options;

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Intentaste pagar tu suscripción de <strong style="color:${COLORS.textPrimary};">${escapeHtml(orgName)}</strong>,
      pero el pago no se completó.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      ${escapeHtml(ownerMessage)}
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ir a Facturación</a>
      </td></tr>
    </table>`;

  const preheader = ownerMessage;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Pago no completado',
    preheader,
  });

  return wrapEmailDocument({
    title: buildCheckoutPaymentRejectedSubject(orgName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildCheckoutPaymentRejectedSubject,
  buildCheckoutPaymentRejectedHtml,
};
