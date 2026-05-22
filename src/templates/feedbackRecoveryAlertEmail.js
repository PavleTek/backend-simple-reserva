'use strict';

const { formatDateDisplay, formatTime } = require('../utils/dateFormat');
const { escapeHtml, resolveLogoImageUrl } = require('./reservationConfirmationEmail');

const COLORS = {
  pageBg: '#faf9f6',
  cardBg: '#fdfcfa',
  border: '#e8e7e3',
  textPrimary: '#1c1b17',
  textSecondary: '#535146',
  textMuted: '#8a8675',
  primary600: '#8b2d3a',
  primary700: '#6e2330',
  alertHigh: '#6e2330',
  alertHighBg: '#faf0f1',
  alertMedium: '#92400e',
  alertMediumBg: '#fffbeb',
  contactBg: '#fff7ed',
  contactBorder: '#f59e0b',
};

const SEVERITY_LABELS = {
  high: 'Urgente',
  medium: 'Importante',
  low: 'Por revisar',
};

const SEVERITY_STYLES = {
  high: { color: COLORS.alertHigh, bg: COLORS.alertHighBg, emoji: '🚨' },
  medium: { color: COLORS.alertMedium, bg: COLORS.alertMediumBg, emoji: '⚠️' },
  low: { color: COLORS.textSecondary, bg: '#f5f4f0', emoji: '⚠️' },
};

const DEFAULT_SITE_URL = 'https://simplereserva.com';

function resolveSiteHomeUrl(assetBaseUrl) {
  if (!assetBaseUrl || typeof assetBaseUrl !== 'string') return DEFAULT_SITE_URL;
  try {
    const u = new URL(assetBaseUrl);
    if (u.protocol === 'https:') return u.origin;
  } catch {
    /* ignore */
  }
  return DEFAULT_SITE_URL;
}

function formatVisitShort(visitDateTime, partySize, timezone) {
  if (!visitDateTime) return null;
  const dt = new Date(visitDateTime);
  const date = formatDateDisplay(dt, timezone || undefined);
  const time = formatTime(dt, timezone || undefined);
  const partyStr =
    partySize != null ? ` · ${partySize} ${partySize === 1 ? 'persona' : 'personas'}` : '';
  return `${date}, ${time}${partyStr}`;
}

function formatCategoryScores(categoryScores = {}) {
  const parts = [];
  if (categoryScores.serviceScore != null) parts.push(`Servicio ${categoryScores.serviceScore}`);
  if (categoryScores.foodScore != null) parts.push(`Comida ${categoryScores.foodScore}`);
  if (categoryScores.atmosphereScore != null) parts.push(`Ambiente ${categoryScores.atmosphereScore}`);
  if (categoryScores.reservationScore != null) parts.push(`Reserva ${categoryScores.reservationScore}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * @param {object} options
 */
function buildFeedbackRecoveryAlertHtml(options) {
  const {
    restaurantName,
    customerName,
    overallScore,
    comment,
    severity = 'medium',
    panelUrl,
    customerEmail,
    customerPhone,
    visitDateTime,
    partySize,
    timezone = null,
    categoryScores = {},
    recoveryContactRequested = false,
    recoveryContactEmail,
    assetBaseUrl = '',
  } = options;

  const safeRestaurant = escapeHtml(restaurantName);
  const safeCustomer = escapeHtml(customerName || 'Cliente');
  const trimmedComment = comment?.trim();
  const safeComment = escapeHtml(trimmedComment || '');
  const safePanel = escapeHtml(panelUrl);
  const severityKey = SEVERITY_LABELS[severity] ? severity : 'medium';
  const severityLabel = SEVERITY_LABELS[severityKey] || 'Importante';
  const sevStyle = SEVERITY_STYLES[severityKey] || SEVERITY_STYLES.medium;
  const siteUrl = resolveSiteHomeUrl(assetBaseUrl);
  const safeSiteUrl = escapeHtml(siteUrl);

  const visitLine = formatVisitShort(visitDateTime, partySize, timezone);
  const categories = formatCategoryScores(categoryScores);
  const contactEmail = recoveryContactEmail || customerEmail;

  const logoUrl = resolveLogoImageUrl(assetBaseUrl);
  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="140" style="display:block;width:140px;height:auto;border:0;" />`
    : `<span style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:${COLORS.primary700};">SimpleReserva</span>`;

  const emailBtn = contactEmail
    ? `<a href="mailto:${escapeHtml(contactEmail)}" style="display:inline-block;margin:4px 6px 4px 0;padding:10px 16px;font-size:14px;font-weight:600;color:#fff !important;text-decoration:none;border-radius:10px;background:${COLORS.primary600};">Correo</a>`
    : '';

  const phoneBtn = customerPhone
    ? `<a href="tel:${escapeHtml(customerPhone.replace(/\s/g, ''))}" style="display:inline-block;margin:4px 0;padding:10px 16px;font-size:14px;font-weight:600;color:${COLORS.primary600} !important;text-decoration:none;border-radius:10px;border:2px solid ${COLORS.primary600};background:#fff;">Llamar</a>`
    : '';

  const contactBlock =
    emailBtn || phoneBtn
      ? `<p style="margin:0 0 8px 0;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${COLORS.textMuted};">Contactar</p>
         <p style="margin:0 0 4px 0;font-size:13px;color:${COLORS.textSecondary};">${emailBtn}${phoneBtn}</p>
         ${
           contactEmail
             ? `<p style="margin:8px 0 0 0;font-size:13px;color:${COLORS.textSecondary};word-break:break-all;">${escapeHtml(contactEmail)}${customerPhone ? ` · ${escapeHtml(customerPhone)}` : ''}</p>`
             : customerPhone
               ? `<p style="margin:8px 0 0 0;font-size:13px;">${escapeHtml(customerPhone)}</p>`
               : ''
         }`
      : `<p style="margin:0;font-size:13px;color:${COLORS.textSecondary};">Sin datos de contacto en la reserva.</p>`;

  const contactUrgent = recoveryContactRequested
    ? `<p style="margin:0 0 12px 0;padding:10px 12px;font-size:13px;font-weight:600;color:${COLORS.alertMedium};background:${COLORS.contactBg};border-radius:10px;border-left:3px solid ${COLORS.contactBorder};">El cliente pidió que lo contacten — responde pronto.</p>`
    : '';

  const commentBlock = trimmedComment
    ? `<p style="margin:0 0 16px 0;padding:12px 14px;font-size:15px;line-height:1.45;color:${COLORS.textPrimary};background:#f5f4f0;border-radius:10px;border-left:3px solid ${COLORS.primary600};white-space:pre-wrap;">&ldquo;${safeComment}&rdquo;</p>`
    : '';

  const categoriesLine = categories
    ? `<p style="margin:4px 0 0 0;font-size:13px;color:${COLORS.textMuted};">${escapeHtml(categories)}</p>`
    : '';

  const preheader = `${safeCustomer} · ${overallScore}/5 · ${restaurantName}${recoveryContactRequested ? ' · pide contacto' : ''}`;

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Alerta mala experiencia — ${safeRestaurant}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.pageBg};">
  <span style="display:none !important;visibility:hidden;font-size:1px;color:${COLORS.pageBg};">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${COLORS.pageBg};">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:${COLORS.cardBg};border-radius:14px;border:1px solid ${COLORS.border};overflow:hidden;">
          <tr>
            <td style="padding:20px 24px 16px 24px;background:${sevStyle.bg};border-bottom:1px solid ${COLORS.border};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding-bottom:12px;">${logoBlock}</td>
                </tr>
                <tr>
                  <td>
                    <span style="font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${sevStyle.color};">${sevStyle.emoji} Mala experiencia · ${escapeHtml(severityLabel)}</span>
                    <h1 style="margin:8px 0 4px 0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${COLORS.textPrimary};line-height:1.3;">${safeCustomer} · <span style="color:${sevStyle.color};">${overallScore}/5</span></h1>
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:${COLORS.textSecondary};">${safeRestaurant}${visitLine ? ` · ${escapeHtml(visitLine)}` : ''}</p>
                    ${categoriesLine}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
              ${contactUrgent}
              ${commentBlock}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;background:#fff;border:1px solid ${COLORS.border};border-radius:12px;">
                <tr>
                  <td style="padding:16px 18px;">${contactBlock}</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <a href="${safePanel}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#fff !important;text-decoration:none;border-radius:11px;background:${COLORS.primary600};">Abrir Experiencia</a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0 0;font-size:12px;line-height:1.5;color:${COLORS.textMuted};text-align:center;">Al resolver el caso, deja una nota interna en el panel (solo la ve tu equipo).</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px 20px;border-top:1px solid ${COLORS.border};font-size:11px;line-height:1.5;color:${COLORS.textMuted};text-align:center;">
              <a href="${safeSiteUrl}" style="color:${COLORS.primary600};text-decoration:none;font-weight:600;">SimpleReserva</a> · reservas para restaurantes en Chile
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * @param {object} options
 */
function getRecoveryAlertSubject({ restaurantName, customerName, overallScore, severity = 'medium' }) {
  const name = (customerName || 'Cliente').trim().slice(0, 35);
  const local = (restaurantName || 'local').trim().slice(0, 40);
  const sev = SEVERITY_STYLES[severity] || SEVERITY_STYLES.medium;
  return `${sev.emoji} ${name} · ${overallScore}/5 · ${local}`;
}

module.exports = {
  buildFeedbackRecoveryAlertHtml,
  getRecoveryAlertSubject,
  SEVERITY_LABELS,
  resolveSiteHomeUrl,
};
