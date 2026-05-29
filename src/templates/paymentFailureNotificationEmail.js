'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

/**
 * @param {string} restaurantName
 * @returns {string}
 */
function buildPaymentFailureSubject(restaurantName) {
  return `Problema con el pago de tu suscripción en ${restaurantName}`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {string} options.panelUrl
 * @param {Date|string} [options.gracePeriodEndsAt]
 * @param {string} [options.recoveryUrl]
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildPaymentFailureNotificationHtml(options) {
  const {
    restaurantName,
    panelUrl,
    gracePeriodEndsAt,
    recoveryUrl,
    assetBaseUrl = '',
  } = options;

  const graceStr = gracePeriodEndsAt
    ? new Date(gracePeriodEndsAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const graceLine = graceStr
    ? `Tienes hasta el <strong>${escapeHtml(graceStr)}</strong> para regularizar tu situación.`
    : 'Tu cuenta entró en un periodo de gracia de <strong>7 días</strong>.';

  const ctaUrl = recoveryUrl || panelUrl;
  const ctaLabel = recoveryUrl ? 'Regularizar pago' : 'Actualizar pago';

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      No pudimos procesar el pago de tu suscripción para
      <strong style="color:${COLORS.textPrimary};">${escapeHtml(restaurantName)}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      ${graceLine}
      Actualiza tu método de pago para evitar interrupciones en el servicio.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">${escapeHtml(ctaLabel)}</a>
      </td></tr>
    </table>`;

  const preheader = `Actualiza el pago de tu suscripción en ${restaurantName}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Problema con tu pago',
    preheader,
  });

  return wrapEmailDocument({
    title: buildPaymentFailureSubject(restaurantName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildPaymentFailureNotificationHtml,
  buildPaymentFailureSubject,
};
