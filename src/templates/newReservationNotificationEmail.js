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
function buildNewReservationSubject(customerName, restaurantName) {
  return `Nueva reserva: ${customerName} · ${restaurantName}`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {string} options.customerName
 * @param {string|null} [options.customerPhone]
 * @param {string|null} [options.customerEmail]
 * @param {string} options.dateStr
 * @param {string} options.timeStr
 * @param {number} options.partySize
 * @param {string} options.panelUrl
 * @param {string} [options.sourceLabel]
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildNewReservationNotificationHtml(options) {
  const {
    restaurantName,
    customerName,
    customerPhone,
    customerEmail,
    dateStr,
    timeStr,
    partySize,
    panelUrl,
    sourceLabel = 'Reserva web',
    assetBaseUrl = '',
  } = options;

  const detailRow = (label, value) =>
    `<tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};width:40%;">${label}</td><td style="padding:6px 0;font-size:15px;color:${COLORS.textPrimary};">${value}</td></tr>`;

  const detailRows = [
    detailRow('Fecha', escapeHtml(dateStr)),
    detailRow('Hora', escapeHtml(timeStr)),
    detailRow('Comensales', escapeHtml(String(partySize))),
    detailRow('Cliente', escapeHtml(customerName)),
    ...(customerPhone ? [detailRow('Teléfono', escapeHtml(customerPhone))] : []),
    ...(customerEmail ? [detailRow('Correo', escapeHtml(customerEmail))] : []),
    detailRow('Origen', escapeHtml(sourceLabel)),
  ].join('');

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tienes una nueva reserva en <strong style="color:${COLORS.textPrimary};">${escapeHtml(restaurantName)}</strong>.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;margin:0 0 24px 0;">
      <tr><td style="padding:18px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${detailRows}
        </table>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ver en el panel</a>
      </td></tr>
    </table>`;

  const preheader = `Nueva reserva de ${customerName} en ${restaurantName}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'NUEVA RESERVA',
    headline: 'Llegó una reserva nueva',
    preheader,
  });

  return wrapEmailDocument({
    title: buildNewReservationSubject(customerName, restaurantName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildNewReservationNotificationHtml,
  buildNewReservationSubject,
};
