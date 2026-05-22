'use strict';

const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const { escapeHtml } = require('./reservationConfirmationEmail');

const COLORS = {
  pageBg: '#faf9f6',
  cardBg: '#fdfcfa',
  border: '#e8e7e3',
  textPrimary: '#1c1b17',
  textSecondary: '#535146',
  textMuted: '#8a8675',
  primary600: '#8b2d3a',
  primary700: '#6e2330',
};

const SUBJECTS = {
  a: (name) => `¿Cómo estuvo tu visita a ${name}?`,
  b: (name) => `${name} — cuéntanos en 30 segundos`,
};

/**
 * @param {object} options
 */
function buildPostVisitFeedbackHtml(options) {
  const {
    restaurantName,
    customerName,
    dateTime,
    clickUrl,
    optOutUrl,
    timezone = null,
  } = options;

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

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>¿Cómo fue tu experiencia?</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.pageBg};">
  <span style="display:none !important;visibility:hidden;font-size:1px;color:${COLORS.pageBg};">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${COLORS.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${COLORS.cardBg};border-radius:16px;border:1px solid ${COLORS.border};">
          <tr>
            <td style="padding:32px 28px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${COLORS.textPrimary};">
              <p style="margin:0 0 12px 0;font-size:15px;color:${COLORS.textSecondary};">Hola ${safeCustomer},</p>
              <p style="margin:0 0 16px 0;">Gracias por venir a <strong>${safeRestaurant}</strong> (${safeDate}, ${safeTime}).</p>
              <p style="margin:0 0 24px 0;color:${COLORS.textSecondary};">¿Nos ayudas con tu opinión? Son un par de toques — nos importa de verdad.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <a href="${safeClick}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#fff !important;text-decoration:none;border-radius:12px;background:${COLORS.primary600};">Contanos cómo fue</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0 0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
                <a href="${safeOptOut}" style="color:${COLORS.textMuted};">No recibir más encuestas</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;border-top:1px solid ${COLORS.border};font-size:12px;color:${COLORS.textMuted};text-align:center;">
              Enviado por SimpleReserva para ${safeRestaurant}
            </td>
          </tr>
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
