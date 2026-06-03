'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

/**
 * @param {number} daysLeft
 * @returns {string}
 */
function buildRenewalReminderSubject(daysLeft, orgName) {
  if (daysLeft <= 1) {
    return `Renueva tu plan SimpleReserva mañana — ${orgName}`;
  }
  return `Renueva tu plan SimpleReserva (quedan ${daysLeft} días) — ${orgName}`;
}

/**
 * @param {Object} options
 * @param {string} options.orgName
 * @param {string} options.planName
 * @param {Date|string} options.periodEnd
 * @param {string} options.checkoutUrl
 * @param {string} options.panelUrl
 * @param {number} options.daysLeft
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildRenewalReminderHtml(options) {
  const {
    orgName,
    planName,
    periodEnd,
    checkoutUrl,
    panelUrl,
    daysLeft,
    assetBaseUrl = '',
    isReferralFreeWindow = false,
  } = options;
  const endStr = periodEnd
    ? new Date(periodEnd).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'pronto';

  const urgency = isReferralFreeWindow
    ? daysLeft <= 1
      ? 'Tus días gratis terminan mañana.'
      : daysLeft <= 4
        ? `Tus días gratis terminan en ${daysLeft} días.`
        : `Tus días gratis terminan el ${endStr}.`
    : daysLeft <= 1
      ? 'Tu suscripción vence mañana.'
      : daysLeft <= 4
        ? `Quedan ${daysLeft} días para renovar.`
        : `Te recordamos que tu periodo de facturación vence el ${endStr}.`;

  const planSentence = isReferralFreeWindow
    ? `${escapeHtml(actionLine)}`
    : `requiere renovación con pago mensual manual.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      ${escapeHtml(urgency)} Tu plan <strong style="color:${COLORS.textPrimary};">${escapeHtml(planName)}</strong>
      para <strong style="color:${COLORS.textPrimary};">${escapeHtml(orgName)}</strong>${isReferralFreeWindow ? ` ${planSentence}` : ` ${planSentence}`}
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Fecha de vencimiento: <strong>${escapeHtml(endStr)}</strong>
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px 0;">
      <tr><td align="center">
        <a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">${isReferralFreeWindow ? 'Activar pago' : 'Renovar suscripción'}</a>
      </td></tr>
    </table>
    <p style="margin:0;color:${COLORS.textMuted};font-size:14px;">
      También puedes ir a <a href="${escapeHtml(panelUrl)}" style="color:${COLORS.primary600};">Facturación</a> en el panel.
      Si ya pagaste, puedes ignorar este correo.
    </p>`;

  const preheader = `${urgency} Renueva antes del ${endStr}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: daysLeft <= 1 ? 'Renueva mañana' : 'Recordatorio de renovación',
    preheader,
  });

  return wrapEmailDocument({
    title: buildRenewalReminderSubject(daysLeft, orgName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildRenewalReminderSubject,
  buildRenewalReminderHtml,
};
