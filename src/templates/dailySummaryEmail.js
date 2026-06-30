'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

const MAX_LIST_ITEMS = 10;

function truncateLabel(value, max) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function totalCovers(reservations) {
  return (reservations || []).reduce((sum, item) => sum + (Number(item.partySize) || 0), 0);
}

/**
 * @param {number} count
 * @param {string} restaurantName
 * @param {string|null} [firstTime]
 * @param {number} [covers]
 * @returns {string}
 */
function buildDailySummarySubject(count, restaurantName, firstTime = null, covers = 0) {
  const n = Number(count) || 0;
  const label = n === 1 ? '1 reserva' : `${n} reservas`;
  const local = truncateLabel(restaurantName, 30);
  const timePart = firstTime ? ` · ${firstTime}` : '';
  const coversPart = covers > 0 ? ` · ${covers} comensales` : '';
  return `Hoy: ${label}${timePart}${coversPart} · ${local}`;
}

/**
 * @param {Array<{ time: string, partySize: number, customerName?: string, tableLabel?: string|null, notes?: string|null }>} items
 * @returns {string}
 */
function buildReservationListHtml(items) {
  if (!items || items.length === 0) return '';

  const header = `<tr>
    <th align="left" style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};border-bottom:1px solid ${COLORS.border};">Hora</th>
    <th align="left" style="padding:8px 0 8px 12px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};border-bottom:1px solid ${COLORS.border};">Cliente</th>
    <th align="left" style="padding:8px 0 8px 12px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};border-bottom:1px solid ${COLORS.border};">Mesa</th>
    <th align="right" style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};border-bottom:1px solid ${COLORS.border};">Pers.</th>
  </tr>`;

  const rows = items.slice(0, MAX_LIST_ITEMS).map((item) => {
    const name = item.customerName ? escapeHtml(item.customerName) : 'Sin nombre';
    const time = escapeHtml(item.time);
    const pax = Number(item.partySize) || 0;
    const table = item.tableLabel ? escapeHtml(item.tableLabel) : '—';
    const notes = item.notes ? String(item.notes).trim() : '';
    const notesLine = notes
      ? `<br/><span style="font-size:12px;color:${COLORS.textMuted};">Nota: ${escapeHtml(truncateLabel(notes, 100))}</span>`
      : '';
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid ${COLORS.border};font-size:15px;font-weight:700;color:${COLORS.textPrimary};white-space:nowrap;vertical-align:top;">${time}</td>
      <td style="padding:12px 0 12px 12px;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textPrimary};vertical-align:top;">${name}${notesLine}</td>
      <td style="padding:12px 0 12px 12px;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textSecondary};white-space:nowrap;vertical-align:top;">${table}</td>
      <td align="right" style="padding:12px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textSecondary};white-space:nowrap;vertical-align:top;">${pax}</td>
    </tr>`;
  });

  const more =
    items.length > MAX_LIST_ITEMS
      ? `<p style="margin:12px 0 0 0;font-size:13px;color:${COLORS.textMuted};">+ ${items.length - MAX_LIST_ITEMS} reserva(s) más en el panel.</p>`
      : '';

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;margin:0 0 24px 0;">
    <tr><td style="padding:16px 18px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${header}${rows.join('')}</table>
      ${more}
    </td></tr>
  </table>`;
}

function buildSummaryStatsHtml(count, covers, firstTime, dateDisplay) {
  const stat = (label, value) =>
    `<td align="center" style="padding:14px 10px;background-color:#faf9f6;border:1px solid ${COLORS.border};border-radius:10px;">
      <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};">${label}</p>
      <p style="margin:0;font-size:18px;font-weight:700;color:${COLORS.textPrimary};">${value}</p>
    </td>`;

  const firstValue = firstTime ? escapeHtml(firstTime) : '—';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
    <tr>
      ${stat('Fecha', escapeHtml(dateDisplay))}
      ${stat('Reservas', escapeHtml(String(count)))}
      ${stat('Comensales', escapeHtml(String(covers)))}
      ${stat('Primera mesa', firstValue)}
    </tr>
  </table>`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {number} options.count
 * @param {string} options.dateDisplay
 * @param {string|null} [options.firstTime]
 * @param {string} options.panelUrl
 * @param {Array<{ time: string, partySize: number, customerName?: string, tableLabel?: string|null, notes?: string|null }>} [options.reservations]
 * @param {string} [options.recipientName]
 * @param {string} [options.assetBaseUrl]
 * @returns {string}
 */
function buildDailySummaryHtml(options) {
  const {
    restaurantName,
    count,
    dateDisplay,
    firstTime = null,
    panelUrl,
    reservations = [],
    recipientName = '',
    assetBaseUrl = '',
  } = options;

  const safeRestaurant = escapeHtml(restaurantName);
  const safeDate = escapeHtml(dateDisplay);
  const safeCount = Number(count) || 0;
  const covers = totalCovers(reservations);
  const countWord = safeCount === 1 ? 'reserva confirmada' : 'reservas confirmadas';
  const greetingName = recipientName ? escapeHtml(recipientName.split(' ')[0]) : null;

  const bodyHtml = `${greetingName ? `<p style="margin:0 0 16px 0;">Hola ${greetingName},</p>` : ''}
    <p style="margin:0 0 8px 0;font-size:16px;color:${COLORS.textPrimary};">
      Este es el resumen de <strong>${safeRestaurant}</strong> para hoy <strong>${safeDate}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tienes <strong style="color:${COLORS.textPrimary};">${safeCount} ${countWord}</strong>${covers > 0 ? ` · <strong style="color:${COLORS.textPrimary};">${covers} comensales</strong> en total` : ''}.
    </p>
    ${buildSummaryStatsHtml(safeCount, covers, firstTime, dateDisplay)}
    ${buildReservationListHtml(reservations)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:8px;">
      <tr>
        <td align="center">
          <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Abrir reservas de hoy</a>
        </td>
      </tr>
    </table>
    <p style="margin:16px 0 0 0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
      Recibes este correo porque estás en las notificaciones de reservas de este local.
    </p>`;

  const preheader = `${safeCount} ${safeCount === 1 ? 'reserva' : 'reservas'} hoy en ${restaurantName}${firstTime ? ` · primera a las ${firstTime}` : ''}.`;
  const headline =
    safeCount === 1
      ? `1 reserva hoy en ${truncateLabel(restaurantName, 36)}`
      : `${safeCount} reservas hoy en ${truncateLabel(restaurantName, 36)}`;

  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'RESUMEN DEL DÍA',
    headline,
    preheader,
  });

  return wrapEmailDocument({
    title: buildDailySummarySubject(safeCount, restaurantName, firstTime, covers),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildDailySummaryHtml,
  buildDailySummarySubject,
  totalCovers,
  MAX_LIST_ITEMS,
};
