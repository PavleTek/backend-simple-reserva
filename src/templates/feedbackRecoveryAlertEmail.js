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
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

const SEVERITY_STYLES = {
  high: { color: COLORS.alertHigh, bg: COLORS.alertHighBg },
  medium: { color: COLORS.alertMedium, bg: COLORS.alertMediumBg },
  low: { color: COLORS.textSecondary, bg: '#f5f4f0' },
};

function formatCategoryScores(categoryScores = {}) {
  const parts = [];
  if (categoryScores.serviceScore != null) parts.push(`Servicio ${categoryScores.serviceScore}/5`);
  if (categoryScores.foodScore != null) parts.push(`Comida ${categoryScores.foodScore}/5`);
  if (categoryScores.atmosphereScore != null) parts.push(`Ambiente ${categoryScores.atmosphereScore}/5`);
  if (categoryScores.reservationScore != null) parts.push(`Reserva ${categoryScores.reservationScore}/5`);
  return parts.length ? parts.join(' · ') : null;
}

function formatVisitLine(visitDateTime, partySize, timezone) {
  if (!visitDateTime) return null;
  const dt = new Date(visitDateTime);
  const date = formatDateDisplay(dt, timezone || undefined);
  const time = formatTime(dt, timezone || undefined);
  const partyStr =
    partySize != null ? ` · ${partySize} ${partySize === 1 ? 'persona' : 'personas'}` : '';
  return `${date}, ${time}${partyStr}`;
}

/**
 * @param {string} label
 * @param {string} valueHtml - already escaped or safe HTML (e.g. mailto link)
 */
function detailRow(label, valueHtml) {
  return `<tr>
    <td style="padding:10px 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};vertical-align:top;width:140px;">${escapeHtml(label)}</td>
  </tr>
  <tr>
    <td style="padding:0 0 14px 0;font-size:15px;line-height:1.45;color:${COLORS.textPrimary};">${valueHtml}</td>
  </tr>`;
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
  const safeComment = escapeHtml(comment?.trim() || 'Sin comentario');
  const safePanel = escapeHtml(panelUrl);
  const severityKey = SEVERITY_LABELS[severity] ? severity : 'medium';
  const severityLabel = SEVERITY_LABELS[severityKey] || severity;
  const sevStyle = SEVERITY_STYLES[severityKey] || SEVERITY_STYLES.medium;

  const visitLine = formatVisitLine(visitDateTime, partySize, timezone);
  const categories = formatCategoryScores(categoryScores);

  const logoUrl = resolveLogoImageUrl(assetBaseUrl);
  const logoBlock = logoUrl
    ? `<tr><td align="center" style="padding:0 0 16px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="180" style="display:block;width:180px;height:auto;max-width:180px;border:0;outline:none;text-decoration:none;" /></td></tr>`
    : `<tr><td align="center" style="padding:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:${COLORS.primary700};">SimpleReserva</td></tr>`;

  const emailRow = customerEmail
    ? detailRow(
        'Email',
        `<a href="mailto:${escapeHtml(customerEmail)}" style="color:${COLORS.primary600};font-weight:600;text-decoration:none;">${escapeHtml(customerEmail)}</a>`,
      )
    : '';

  const phoneRow = customerPhone
    ? detailRow(
        'Teléfono',
        `<a href="tel:${escapeHtml(customerPhone.replace(/\s/g, ''))}" style="color:${COLORS.primary600};font-weight:600;text-decoration:none;">${escapeHtml(customerPhone)}</a>`,
      )
    : '';

  const visitRow = visitLine ? detailRow('Visita', escapeHtml(visitLine)) : '';
  const categoriesRow = categories ? detailRow('Por categoría', escapeHtml(categories)) : '';

  const contactHighlight =
    recoveryContactRequested
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 16px 0;background:${COLORS.contactBg};border:1px solid ${COLORS.contactBorder};border-radius:12px;">
          <tr>
            <td style="padding:14px 16px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:${COLORS.textPrimary};">
              <strong style="color:${COLORS.alertMedium};">El cliente pidió que lo contacten</strong><br/>
              ${
                recoveryContactEmail
                  ? `<a href="mailto:${escapeHtml(recoveryContactEmail)}" style="color:${COLORS.primary600};font-weight:700;font-size:15px;text-decoration:none;">${escapeHtml(recoveryContactEmail)}</a>`
                  : '<span style="color:' +
                    COLORS.textSecondary +
                    ';">Usa el email de la reserva (arriba).</span>'
              }
            </td>
          </tr>
        </table>`
      : '';

  const preheader = `${severityLabel} · ${customerName || 'Cliente'} · ${overallScore}/5 · ${restaurantName}`;

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Alerta recovery — ${safeRestaurant}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.pageBg};">
  <span style="display:none !important;visibility:hidden;font-size:1px;color:${COLORS.pageBg};">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${COLORS.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${COLORS.cardBg};border-radius:16px;border:1px solid ${COLORS.border};overflow:hidden;box-shadow:0 4px 12px rgba(28,27,23,0.06);">
          <tr>
            <td style="padding:24px 28px 12px 28px;background:linear-gradient(180deg,${sevStyle.bg} 0%,${COLORS.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:8px 0 0 0;">
                    <span style="display:inline-block;padding:4px 12px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${sevStyle.color};background:${sevStyle.bg};border-radius:999px;border:1px solid ${COLORS.border};">Alerta recovery · ${escapeHtml(severityLabel)}</span>
                    <h1 style="margin:12px 0 4px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${COLORS.textPrimary};line-height:1.25;text-align:center;">${safeRestaurant}</h1>
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:${COLORS.textSecondary};text-align:center;">Experiencia a mejorar — requiere seguimiento</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 8px 28px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${detailRow('Cliente', `<strong style="font-size:17px;">${safeCustomer}</strong>`)}
                ${emailRow}
                ${phoneRow}
                ${visitRow}
                ${detailRow('Puntuación general', `<strong style="font-size:17px;color:${sevStyle.color};">${overallScore}/5</strong>`)}
                ${categoriesRow}
                ${detailRow('Comentario', `<span style="display:block;padding:12px 14px;background:#f5f4f0;border-radius:10px;border-left:3px solid ${COLORS.primary600};white-space:pre-wrap;">${safeComment}</span>`)}
              </table>
              ${contactHighlight}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 20px 0;">
                <tr>
                  <td align="center">
                    <a href="${safePanel}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#fff !important;text-decoration:none;border-radius:12px;background:${COLORS.primary600};">Ver en Experiencia</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 22px;border-top:1px solid ${COLORS.border};font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${COLORS.textMuted};text-align:center;">
              Alerta automática de SimpleReserva · ${safeRestaurant}
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
function getRecoveryAlertSubject({ restaurantName, customerName, overallScore, severity }) {
  const label = SEVERITY_LABELS[severity] || 'Alerta';
  const name = (customerName || 'Cliente').trim().slice(0, 40);
  return `[Experiencia] ${label} · ${name} (${overallScore}/5) — ${restaurantName}`;
}

module.exports = { buildFeedbackRecoveryAlertHtml, getRecoveryAlertSubject, SEVERITY_LABELS };
