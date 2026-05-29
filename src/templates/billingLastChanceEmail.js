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
function buildLastChanceSubject(orgName) {
  return `Última oportunidad para regularizar tu pago — ${orgName}`;
}

/**
 * @param {Object} options
 * @param {string} options.orgName
 * @param {Date|string} options.gracePeriodEndsAt
 * @param {string} options.checkoutUrl
 * @param {string} options.panelUrl
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildLastChanceHtml(options) {
  const { orgName, gracePeriodEndsAt, checkoutUrl, panelUrl, assetBaseUrl = '' } = options;
  const graceStr = gracePeriodEndsAt
    ? new Date(gracePeriodEndsAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'pronto';

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tu acceso a SimpleReserva para <strong style="color:${COLORS.textPrimary};">${escapeHtml(orgName)}</strong>
      se suspenderá el <strong>${escapeHtml(graceStr)}</strong> si no regularizas el pago.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px 0;">
      <tr><td align="center">
        <a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Pagar ahora</a>
      </td></tr>
    </table>
    <p style="margin:0;color:${COLORS.textMuted};font-size:14px;">
      O visita <a href="${escapeHtml(panelUrl)}" style="color:${COLORS.primary600};">Facturación</a> en el panel.
    </p>`;

  const preheader = `Regulariza antes del ${graceStr} para no perder acceso.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Última oportunidad',
    preheader,
  });

  return wrapEmailDocument({
    title: buildLastChanceSubject(orgName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildLastChanceSubject,
  buildLastChanceHtml,
};
