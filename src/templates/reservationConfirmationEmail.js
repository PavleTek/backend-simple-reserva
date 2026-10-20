'use strict';

const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const {
  escapeHtml,
  resolveLogoImageUrl,
  resolveRestaurantLogoImageUrl,
  resolveGuestEmailPresentation,
  buildGuestEmailLogoBlock,
  buildSimpleReservaEmailFooter,
} = require('./emailLayout');

/**
 * Builds a restaurant-specific HTML email template for reservation confirmation.
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {string} options.customerName
 * @param {Date|string} options.dateTime
 * @param {number} options.partySize
 * @param {string} options.viewUrl
 * @param {string|null} [options.timezone]
 * @param {string} [options.assetBaseUrl]
 * @param {string|null} [options.restaurantLogoUrl]
 * @param {string|null} [options.appearanceTheme]
 * @returns {string} HTML content
 */
function buildReservationConfirmationHtml(options) {
  const {
    restaurantName,
    customerName,
    dateTime,
    partySize,
    viewUrl,
    timezone = null,
    assetBaseUrl = '',
    restaurantLogoUrl = null,
    appearanceTheme = null,
  } = options;

  const { branded, restaurantLogoUrl: validLogo, colors } = resolveGuestEmailPresentation({
    restaurantLogoUrl,
    appearanceTheme,
  });

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt, timezone || undefined);
  const timeStr = formatTime(dt, timezone || undefined);

  const safeRestaurant = escapeHtml(restaurantName);
  const safeCustomer = escapeHtml(customerName);
  const safeViewUrl = escapeHtml(viewUrl);
  const safeDate = escapeHtml(dateStr);
  const safeTime = escapeHtml(timeStr);
  const safeParty = escapeHtml(String(partySize));

  const preheader = `${dateStr} · ${timeStr} · ${partySize} pers. · ${restaurantName}`;
  const safePreheader = escapeHtml(preheader);

  const logoBlock = buildGuestEmailLogoBlock({
    restaurantLogoUrl: validLogo,
    restaurantName,
    assetBaseUrl,
    colors,
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Confirmación de reserva</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style type="text/css">
    body { margin:0 !important; padding:0 !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${colors.primary600}; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${colors.pageBg};">
  <span style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${colors.pageBg};max-height:0;max-width:0;opacity:0;overflow:hidden;">${safePreheader}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${colors.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:${colors.cardBg};border-radius:16px;border:1px solid ${colors.border};overflow:hidden;box-shadow:0 4px 12px rgba(28,27,23,0.06);">
          <tr>
            <td style="padding:28px 32px 8px 32px;background:linear-gradient(180deg,${colors.headerGradientFrom} 0%,${colors.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:4px 0 0 0;">
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${colors.primary600};">Reserva confirmada</p>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${colors.textPrimary};line-height:1.2;">${safeRestaurant}</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${colors.textPrimary};">
              <p style="margin:0 0 16px 0;">Hola <strong style="color:${colors.textPrimary};">${safeCustomer}</strong>,</p>
              <p style="margin:0 0 24px 0;color:${colors.textSecondary};">Gracias por reservar con <strong style="color:${colors.textPrimary};">${safeRestaurant}</strong>. Aquí tienes el resumen de tu mesa:</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${colors.nestedBg};border:1px solid ${colors.border};border-radius:12px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding:8px 0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:${colors.textSecondary};width:42%;">Fecha</td>
                        <td style="padding:8px 0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:${colors.textPrimary};">${safeDate}</td>
                      </tr>
                      <tr>
                        <td colspan="2" style="border-top:1px solid ${colors.border};font-size:0;line-height:0;height:1px;">&nbsp;</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:${colors.textSecondary};">Hora</td>
                        <td style="padding:8px 0;font-size:15px;font-weight:700;color:${colors.textPrimary};">${safeTime}</td>
                      </tr>
                      <tr>
                        <td colspan="2" style="border-top:1px solid ${colors.border};font-size:0;line-height:0;height:1px;">&nbsp;</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:${colors.textSecondary};">Comensales</td>
                        <td style="padding:8px 0;font-size:15px;font-weight:700;color:${colors.textPrimary};">${safeParty} persona${Number(partySize) === 1 ? '' : 's'}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
                <tr>
                  <td align="center" style="padding:0;">
                    <a href="${safeViewUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:${colors.primaryTextOn} !important;text-decoration:none;border-radius:12px;background-color:${colors.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Ver o gestionar mi reserva</a>
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0 0;font-size:14px;line-height:1.5;color:${colors.textSecondary};text-align:center;">¿Cambios o cancelación? Usa el botón — también puedes <a href="${safeViewUrl}" style="color:${colors.primary600};font-weight:600;">abrir este enlace</a> en tu navegador.</p>
            </td>
          </tr>
          ${buildSimpleReservaEmailFooter(restaurantName, {
            border: colors.border,
            textMuted: colors.textMuted,
            padding: '20px 32px 28px',
            showBrandMark: branded,
            isDark: colors.isDark,
            assetBaseUrl,
            primary700: colors.primary700,
          })}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  buildReservationConfirmationHtml,
  buildSimpleReservaEmailFooter,
  escapeHtml,
  resolveLogoImageUrl,
  resolveRestaurantLogoImageUrl,
};
