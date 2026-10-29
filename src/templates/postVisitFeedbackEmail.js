'use strict';

const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const {
  escapeHtml,
  resolveGuestEmailPresentation,
  buildGuestEmailLogoBlock,
  buildSimpleReservaEmailFooter,
} = require('./emailLayout');

const SUBJECTS = {
  a: (name) => `¿Cómo estuvo tu visita a ${name}?`,
  b: (name) => `${name} — cuéntanos en 30 segundos`,
};

/**
 * @param {object} options
 * @param {string} [options.assetBaseUrl]
 * @param {string|null} [options.restaurantLogoUrl]
 * @param {string|null} [options.appearanceTheme]
 */
function buildPostVisitFeedbackHtml(options) {
  const {
    restaurantName,
    customerName,
    dateTime,
    clickUrl,
    optOutUrl,
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
  const safeCustomer = escapeHtml(customerName || 'ahí');
  const safeClick = escapeHtml(clickUrl);
  const safeOptOut = escapeHtml(optOutUrl);
  const safeDate = escapeHtml(dateStr);
  const safeTime = escapeHtml(timeStr);
  const preheader = `Tu visita del ${dateStr} · ${restaurantName}`;

  const logoBlock = buildGuestEmailLogoBlock({
    restaurantLogoUrl: validLogo,
    restaurantName,
    assetBaseUrl,
    colors,
  });

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>¿Cómo fue tu experiencia?</title>
</head>
<body style="margin:0;padding:0;background-color:${colors.pageBg};">
  <span style="display:none !important;visibility:hidden;font-size:1px;color:${colors.pageBg};">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${colors.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${colors.cardBg};border-radius:16px;border:1px solid ${colors.border};overflow:hidden;box-shadow:0 4px 12px rgba(28,27,23,0.06);">
          <tr>
            <td style="padding:28px 32px 8px 32px;background:linear-gradient(180deg,${colors.headerGradientFrom} 0%,${colors.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:4px 0 0 0;">
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${colors.primary600};">Tu opinión importa</p>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:${colors.textPrimary};line-height:1.2;">${safeRestaurant}</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 28px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${colors.textPrimary};text-align:center;">
              <p style="margin:0 0 12px 0;font-size:15px;color:${colors.textSecondary};text-align:center;">Hola ${safeCustomer},</p>
              <p style="margin:0 0 16px 0;text-align:center;">Gracias por venir a <strong>${safeRestaurant}</strong><br/>${safeDate}, ${safeTime}.</p>
              <p style="margin:0 0 24px 0;color:${colors.textSecondary};text-align:center;">¿Nos ayudas con tu opinión? Son unos minutos y nos importa de verdad.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <a href="${safeClick}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:${colors.primaryTextOn} !important;text-decoration:none;border-radius:12px;background:${colors.primary600};">Cuéntanos cómo fue</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0 0;font-size:13px;color:${colors.textMuted};text-align:center;">
                <a href="${safeOptOut}" style="color:${colors.textMuted};">No recibir más encuestas</a>
              </p>
            </td>
          </tr>
          ${buildSimpleReservaEmailFooter(restaurantName, {
            border: colors.border,
            textMuted: colors.textMuted,
            padding: '16px 28px 24px',
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

function getSubject(restaurantName, variant = 'a') {
  const fn = SUBJECTS[variant] || SUBJECTS.a;
  return fn(restaurantName);
}

module.exports = { buildPostVisitFeedbackHtml, getSubject, SUBJECTS };
