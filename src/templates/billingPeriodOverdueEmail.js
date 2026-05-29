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
function buildPeriodOverdueSubject(orgName) {
  return `Tu periodo de SimpleReserva venció — ${orgName}`;
}

/**
 * @param {Object} options
 * @param {string} options.orgName
 * @param {string} options.planName
 * @param {Date|string} options.periodEnd
 * @param {Date|string} options.gracePeriodEndsAt
 * @param {string} options.checkoutUrl
 * @param {string} options.panelUrl
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildPeriodOverdueHtml(options) {
  const {
    orgName,
    planName,
    periodEnd,
    gracePeriodEndsAt,
    checkoutUrl,
    panelUrl,
    assetBaseUrl = '',
  } = options;

  const endStr = periodEnd
    ? new Date(periodEnd).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'recientemente';
  const graceStr = gracePeriodEndsAt
    ? new Date(gracePeriodEndsAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : '7 días';

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tu periodo de facturación para <strong style="color:${COLORS.textPrimary};">${escapeHtml(orgName)}</strong>
      (plan <strong>${escapeHtml(planName)}</strong>) venció el <strong>${escapeHtml(endStr)}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tienes hasta el <strong>${escapeHtml(graceStr)}</strong> para regularizar tu situación y mantener el acceso.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px 0;">
      <tr><td align="center">
        <a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Pagar ahora</a>
      </td></tr>
    </table>
    <p style="margin:0;color:${COLORS.textMuted};font-size:14px;">
      También puedes ir a <a href="${escapeHtml(panelUrl)}" style="color:${COLORS.primary600};">Facturación</a> en el panel.
    </p>`;

  const preheader = `Regulariza tu pago antes del ${graceStr}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Periodo vencido',
    preheader,
  });

  return wrapEmailDocument({
    title: buildPeriodOverdueSubject(orgName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildPeriodOverdueSubject,
  buildPeriodOverdueHtml,
};
