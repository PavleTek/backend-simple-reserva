'use strict';

const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const {
  COLORS,
  escapeHtml,
} = require('./emailLayout');
const {
  buildSimpleReservaEmailFooter,
  resolveLogoImageUrl,
} = require('./reservationConfirmationEmail');

/**
 * @param {string} restaurantName
 * @param {string} timeStr
 * @returns {string}
 */
function buildReservationReminderSubject(restaurantName, timeStr) {
  const local = String(restaurantName || 'tu restaurante').trim();
  const time = String(timeStr || '').trim();
  if (time) return `Recordatorio: mañana a las ${time} en ${local}`;
  return `Recordatorio: tu reserva es mañana en ${local}`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {string} options.customerName
 * @param {Date|string} options.dateTime
 * @param {number} options.partySize
 * @param {string} options.viewUrl
 * @param {string|null} [options.timezone]
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildReservationReminderHtml(options) {
  const {
    restaurantName,
    customerName,
    dateTime,
    partySize,
    viewUrl,
    timezone = null,
    assetBaseUrl = '',
  } = options;

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt, timezone || undefined);
  const timeStr = formatTime(dt, timezone || undefined);
  const safeRestaurant = escapeHtml(restaurantName);
  const safeCustomer = escapeHtml(customerName);
  const safeViewUrl = escapeHtml(viewUrl);
  const safeDate = escapeHtml(dateStr);
  const safeTime = escapeHtml(timeStr);
  const safeParty = escapeHtml(String(partySize));
  const paxLabel = Number(partySize) === 1 ? '1 persona' : `${partySize} personas`;

  const preheader = `Mañana ${dateStr} a las ${timeStr} · ${partySize} pers. · ${restaurantName}`;
  const safePreheader = escapeHtml(preheader);

  const logoUrl = resolveLogoImageUrl(assetBaseUrl);
  const logoBlock = logoUrl
    ? `<tr><td align="center" style="padding:0 0 20px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="200" style="display:block;width:200px;height:auto;max-width:200px;border:0;outline:none;text-decoration:none;" /></td></tr>`
    : `<tr><td align="center" style="padding:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${COLORS.primary700};letter-spacing:-0.02em;">SimpleReserva</td></tr>`;

  const detailRow = (label, value) =>
    `<tr><td style="padding:8px 0;font-size:13px;font-weight:600;color:${COLORS.textSecondary};width:38%;">${label}</td><td style="padding:8px 0;font-size:15px;color:${COLORS.textPrimary};">${value}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Recordatorio de reserva</title>
  <style type="text/css">
    body { margin:0 !important; padding:0 !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${COLORS.primary600}; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.pageBg};">
  <span style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.pageBg};max-height:0;max-width:0;opacity:0;overflow:hidden;">${safePreheader}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${COLORS.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:${COLORS.cardBg};border-radius:16px;border:1px solid ${COLORS.border};overflow:hidden;box-shadow:0 4px 12px rgba(28,27,23,0.06);">
          <tr>
            <td style="padding:28px 32px 8px 32px;background:linear-gradient(180deg,#faf0f1 0%,${COLORS.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:4px 0 0 0;">
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.primary600};">RECORDATORIO</p>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${COLORS.textPrimary};line-height:1.2;">Tu reserva es mañana</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${COLORS.textPrimary};">
              <p style="margin:0 0 16px 0;">Hola ${safeCustomer},</p>
              <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
                Te recordamos tu reserva en <strong style="color:${COLORS.textPrimary};">${safeRestaurant}</strong>.
                Aquí van los detalles para mañana.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;margin:0 0 24px 0;">
                <tr><td style="padding:18px 20px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    ${detailRow('Fecha', safeDate)}
                    ${detailRow('Hora', safeTime)}
                    ${detailRow('Comensales', safeParty)}
                    ${detailRow('Local', safeRestaurant)}
                  </table>
                </td></tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:8px;">
                <tr><td align="center">
                  <a href="${safeViewUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Ver o cancelar reserva</a>
                </td></tr>
              </table>
              <p style="margin:16px 0 0 0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
                ${paxLabel} · ${safeDate} a las ${safeTime}
              </p>
            </td>
          </tr>
          ${buildSimpleReservaEmailFooter(restaurantName, { border: COLORS.border, textMuted: COLORS.textMuted, padding: '16px 28px 24px' })}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  buildReservationReminderHtml,
  buildReservationReminderSubject,
};
