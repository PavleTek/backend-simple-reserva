'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

/** ~35–40 chars visible on phone lock screen; keep core info in that window. */
const SUBJECT_MAX_LEN = 65;

/**
 * @param {string} value
 * @param {number} max
 */
function truncateLabel(value, max) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Subject optimized for mobile lock screen / inbox list (OpenTable, Resy, Calendly pattern:
 * when + who + size first; local name last).
 *
 * @param {Object} options
 * @param {string} options.customerName
 * @param {string} options.restaurantName
 * @param {string} [options.timeStr] HH:mm
 * @param {string} [options.dateShort] hoy | mañana | dd/MM
 * @param {number} [options.partySize]
 * @returns {string}
 */
function buildNewReservationSubject({
  customerName,
  restaurantName,
  timeStr = '',
  dateShort = '',
  partySize,
}) {
  const name = truncateLabel(customerName || 'Cliente', 26);
  const local = truncateLabel(restaurantName || 'local', 24);
  const time = String(timeStr || '').trim();
  const when = String(dateShort || '').trim();
  const whenTime =
    time && when ? `${time} ${when}` : time || when;

  const pers =
    partySize != null && Number.isFinite(Number(partySize)) && Number(partySize) > 0
      ? `${Number(partySize)}p`
      : '';

  const core = ['📅', whenTime, name, pers].filter(Boolean).join(' · ');
  if (!local) return core;
  const withLocal = `${core} · ${local}`;
  if (withLocal.length <= SUBJECT_MAX_LEN) return withLocal;
  return core.length <= SUBJECT_MAX_LEN ? core : truncateLabel(core, SUBJECT_MAX_LEN);
}

/**
 * Inbox preheader (gray text beside subject in Gmail/Apple Mail).
 *
 * @param {Object} options
 * @param {number} options.partySize
 * @param {string} options.restaurantName
 * @param {string} [options.sourceLabel]
 * @param {string|null} [options.customerPhone]
 */
function buildNewReservationPreheader({
  partySize,
  restaurantName,
  sourceLabel = 'Reserva web',
  customerPhone = null,
}) {
  const n = Number(partySize) || 0;
  const guests = n === 1 ? '1 comensal' : `${n} comensales`;
  const phone = customerPhone ? String(customerPhone).trim() : '';
  const parts = [
    truncateLabel(restaurantName, 40),
    guests,
    sourceLabel,
    phone ? truncateLabel(phone, 18) : '',
    'Ver en el panel',
  ].filter(Boolean);
  return parts.join(' · ');
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
 * @param {string} [options.dateShort]
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
    dateShort = '',
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

  const preheader = buildNewReservationPreheader({
    partySize,
    restaurantName,
    sourceLabel,
    customerPhone,
  });
  const whenLine = [timeStr, dateShort].filter(Boolean).join(' · ');
  const headline = whenLine
    ? `${customerName} · ${whenLine} · ${partySize} ${partySize === 1 ? 'comensal' : 'comensales'}`
    : 'Llegó una reserva nueva';

  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'NUEVA RESERVA',
    headline: truncateLabel(headline, 72),
    preheader,
  });

  return wrapEmailDocument({
    title: buildNewReservationSubject({
      customerName,
      restaurantName,
      timeStr,
      dateShort,
      partySize,
    }),
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
  buildNewReservationPreheader,
};
