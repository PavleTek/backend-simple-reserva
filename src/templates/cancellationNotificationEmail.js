'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

/**
 * @param {string} customerName
 * @param {string} restaurantName
 * @returns {string}
 */
function buildCancellationSubject(customerName, restaurantName) {
  return `Reserva cancelada: ${customerName} en ${restaurantName}`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {string} options.customerName
 * @param {string} options.customerPhone
 * @param {string} options.dateStr
 * @param {string} options.timeStr
 * @param {number} options.partySize
 * @param {string} options.panelUrl
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildCancellationNotificationHtml(options) {
  const {
    restaurantName,
    customerName,
    customerPhone,
    dateStr,
    timeStr,
    partySize,
    panelUrl,
    assetBaseUrl = '',
  } = options;

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Un cliente canceló una reserva en <strong style="color:${COLORS.textPrimary};">${escapeHtml(restaurantName)}</strong>.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;margin:0 0 24px 0;">
      <tr><td style="padding:18px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};width:40%;">Cliente</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${escapeHtml(customerName)}</td></tr>
          <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};">Teléfono</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${escapeHtml(customerPhone)}</td></tr>
          <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};">Fecha</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${escapeHtml(dateStr)}</td></tr>
          <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};">Hora</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${escapeHtml(timeStr)}</td></tr>
          <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};">Comensales</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${escapeHtml(String(partySize))}</td></tr>
        </table>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ver en el panel</a>
      </td></tr>
    </table>`;

  const preheader = `Reserva cancelada por ${customerName} en ${restaurantName}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'CANCELACIÓN',
    headline: 'Una reserva fue cancelada',
    preheader,
  });

  return wrapEmailDocument({
    title: buildCancellationSubject(customerName, restaurantName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildCancellationNotificationHtml,
  buildCancellationSubject,
};
