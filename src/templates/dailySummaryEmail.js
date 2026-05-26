'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

const MAX_LIST_ITEMS = 8;

/**
 * @param {number} count
 * @param {string} restaurantName
 * @returns {string}
 */
function buildDailySummarySubject(count, restaurantName) {
  const n = Number(count) || 0;
  const label = n === 1 ? '1 reserva' : `${n} reservas`;
  return `SimpleReserva: ${label} hoy en ${restaurantName}`;
}

/**
 * @param {Array<{ time: string, partySize: number, customerName?: string }>} items
 * @returns {string}
 */
function buildReservationListHtml(items) {
  if (!items || items.length === 0) return '';
  const rows = items.slice(0, MAX_LIST_ITEMS).map((item) => {
    const name = item.customerName ? escapeHtml(item.customerName) : 'Sin nombre';
    const time = escapeHtml(item.time);
    const pax = Number(item.partySize) || 0;
    const paxLabel = pax === 1 ? '1 comensal' : `${pax} comensales`;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textPrimary};">
        <strong>${time}</strong> · ${paxLabel}<br/>
        <span style="color:${COLORS.textSecondary};">${name}</span>
      </td>
    </tr>`;
  });
  const more =
    items.length > MAX_LIST_ITEMS
      ? `<p style="margin:8px 0 0 0;font-size:13px;color:${COLORS.textMuted};">Y ${items.length - MAX_LIST_ITEMS} reserva(s) más en el panel.</p>`
      : '';

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;margin:0 0 24px 0;">
    <tr><td style="padding:14px 18px;">
      <p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">Resumen del día</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows.join('')}</table>
      ${more}
    </td></tr>
  </table>`;
}

/**
 * @param {Object} options
 * @param {string} options.restaurantName
 * @param {number} options.count
 * @param {string} options.dateDisplay - ej. 26/05/2026
 * @param {string|null} [options.firstTime]
 * @param {string} options.panelUrl
 * @param {Array<{ time: string, partySize: number, customerName?: string }>} [options.reservations]
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
    assetBaseUrl = '',
  } = options;

  const safeRestaurant = escapeHtml(restaurantName);
  const safeDate = escapeHtml(dateDisplay);
  const safeCount = escapeHtml(String(count));
  const safePanelUrl = escapeHtml(panelUrl);
  const countWord = Number(count) === 1 ? 'reserva' : 'reservas';

  const firstLine = firstTime
    ? `<p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">La primera es a las <strong style="color:${COLORS.textPrimary};">${escapeHtml(firstTime)}</strong>.</p>`
    : '';

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Hoy <strong style="color:${COLORS.textPrimary};">${safeDate}</strong> tienes
      <strong style="color:${COLORS.textPrimary};">${safeCount} ${countWord}</strong> confirmada${Number(count) === 1 ? '' : 's'} en
      <strong style="color:${COLORS.textPrimary};">${safeRestaurant}</strong>.
    </p>
    ${firstLine}
    ${buildReservationListHtml(reservations)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:8px;">
      <tr>
        <td align="center">
          <a href="${safePanelUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Ver reservas del día</a>
        </td>
      </tr>
    </table>`;

  const preheader = `Hoy tienes ${count} ${countWord} en ${restaurantName}. Revisa tu panel.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'RESUMEN DEL DÍA',
    headline: `Tienes ${count} ${countWord} hoy`,
    preheader,
  });

  return wrapEmailDocument({
    title: buildDailySummarySubject(count, restaurantName),
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
  MAX_LIST_ITEMS,
};
