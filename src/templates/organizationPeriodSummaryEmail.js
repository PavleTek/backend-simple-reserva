'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

function formatNumber(n) {
  return new Intl.NumberFormat('es-CL').format(Number(n) || 0);
}

/** Limpia sufijos internos como " Org" que no deben aparecer en correos al cliente. */
function displayOrgName(name) {
  return (name ?? 'tu restaurante').replace(/\s+Org\s*$/i, '').trim();
}

function statCard(label, value, sub) {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(String(value));
  const subHtml = sub
    ? `<p style="margin:4px 0 0 0;font-size:12px;color:${COLORS.textMuted};">${escapeHtml(sub)}</p>`
    : '';
  return `<td width="50%" style="padding:6px;vertical-align:top;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f4f0;border:1px solid ${COLORS.border};border-radius:12px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">${safeLabel}</p>
        <p style="margin:0;font-size:22px;font-weight:700;color:${COLORS.textPrimary};">${safeValue}</p>
        ${subHtml}
      </td></tr>
    </table>
  </td>`;
}

function buildHighlightsHtml(highlights) {
  if (!highlights?.length) return '';
  const items = highlights
    .map(
      (h) =>
        `<li style="margin:0 0 9px 0;color:${COLORS.textPrimary};font-size:14px;line-height:1.5;">${escapeHtml(h)}</li>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
    <tr><td style="padding:16px 20px;background:linear-gradient(135deg,#faf0f1 0%,#f5f4f0 100%);border:1px solid ${COLORS.border};border-radius:12px;">
      <p style="margin:0 0 3px 0;font-size:11px;font-weight:700;color:${COLORS.primary600};text-transform:uppercase;letter-spacing:0.07em;">Lo que lograste en tu prueba</p>
      <p style="margin:0 0 12px 0;font-size:12px;color:${COLORS.textMuted};">Cada número es una mesa que tu equipo no tuvo que coordinar por teléfono.</p>
      <ul style="margin:0;padding-left:18px;">${items}</ul>
    </td></tr>
  </table>`;
}

function buildGrowthProjectionsHtml(projections) {
  if (!projections?.length) return '';

  const MONTH_LABELS = { 1: '1 mes', 3: '3 meses', 6: '6 meses', 12: '1 año' };
  const growthLabel = projections[0]?.growthLabel ?? 'moderado';

  // 4-column inline layout; pairs of 2 on narrow viewports (via table nesting)
  const cells = projections.map((p, i) => {
    const isFirst = i === 0;
    const bg = isFirst ? COLORS.primary600 : '#fff';
    const color = isFirst ? '#fff' : COLORS.textPrimary;
    const subColor = isFirst ? 'rgba(255,255,255,0.75)' : COLORS.textMuted;
    const border = isFirst ? `border:1px solid ${COLORS.primary600}` : `border:1px solid ${COLORS.border}`;
    return `<td width="25%" style="padding:4px;vertical-align:top;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
        style="background:${bg};${border};border-radius:10px;text-align:center;">
        <tr><td style="padding:12px 8px 10px 8px;">
          <p style="margin:0 0 4px 0;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${subColor};">${MONTH_LABELS[p.months] ?? `${p.months} meses`}</p>
          <p style="margin:0 0 0px 0;font-size:9px;color:${subColor};font-style:italic;">podrías llegar a</p>
          <p style="margin:0 0 2px 0;font-size:20px;font-weight:700;color:${color};">~${formatNumber(p.reservations)}</p>
          <p style="margin:0 0 4px 0;font-size:11px;color:${subColor};">res/mes aprox.</p>
          <p style="margin:0;font-size:12px;font-weight:600;color:${color};">~${formatNumber(p.covers)} pax</p>
        </td></tr>
      </table>
    </td>`;
  }).join('');

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 6px 0;">
    <tr>${cells}</tr>
  </table>
  <p style="margin:0 0 24px 0;font-size:11px;color:${COLORS.textMuted};text-align:right;">
    Estimación referencial basada en tu ritmo actual y patrones de adopción de reservas online. Los resultados reales pueden variar.
  </p>`;
}

function buildProjectionHtml(projection) {
  if (!projection?.callout) return '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
    <tr><td style="padding:14px 16px;background:#faf9f6;border:1px solid ${COLORS.border};border-radius:12px;font-size:14px;line-height:1.6;color:${COLORS.textPrimary};">
      ${escapeHtml(projection.callout)}
    </td></tr>
  </table>`;
}

function buildRestaurantTableHtml(rows) {
  if (!rows?.length) return '';
  const trs = rows.slice(0, 8).map((r) => {
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textPrimary};">${escapeHtml(r.name)}</td>
      <td align="right" style="padding:8px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textSecondary};">${formatNumber(r.reservations)} res.</td>
      <td align="right" style="padding:8px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textSecondary};">${formatNumber(r.covers)} pax</td>
    </tr>`;
  });
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
    <tr><td>
      <p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">Por local</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <th align="left" style="padding:0 0 6px 0;font-size:12px;color:${COLORS.textMuted};">Local</th>
          <th align="right" style="padding:0 0 6px 0;font-size:12px;color:${COLORS.textMuted};">Reservas</th>
          <th align="right" style="padding:0 0 6px 0;font-size:12px;color:${COLORS.textMuted};">Comensales</th>
        </tr>
        ${trs.join('')}
      </table>
    </td></tr>
  </table>`;
}

// Orden cognitivo positivo → negativo para estados de reserva
const STATUS_DISPLAY_ORDER = ['confirmed', 'completed', 'no_show', 'cancelled'];
const STATUS_CHIP_STYLES = {
  confirmed: `background:#f0fdf4;border:1px solid #86efac;color:#166534;`,
  completed: `background:#eff6ff;border:1px solid #93c5fd;color:#1e40af;`,
  cancelled: `background:#f9fafb;border:1px solid #d1d5db;color:#6b7280;`,
  no_show:   `background:#f9fafb;border:1px solid #d1d5db;color:#6b7280;`,
};
const DEFAULT_CHIP_STYLE = `background:#fff;border:1px solid ${COLORS.border};color:${COLORS.textPrimary};`;

function buildStatusBreakdownHtml(entries) {
  const map = entries || {};
  // Mostrar primero los estados positivos; negativos al final y visualmente apagados
  const ordered = STATUS_DISPLAY_ORDER
    .filter((k) => map[k]?.count > 0)
    .map((k) => ({ key: k, ...map[k] }));
  // Añadir cualquier estado desconocido al final
  Object.entries(map).forEach(([k, v]) => {
    if (!STATUS_DISPLAY_ORDER.includes(k) && v.count > 0) ordered.push({ key: k, ...v });
  });
  if (!ordered.length) return '';
  const chips = ordered
    .map((e) => {
      const style = STATUS_CHIP_STYLES[e.key] ?? DEFAULT_CHIP_STYLE;
      return `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 14px;font-size:13px;border-radius:999px;${style}"><strong>${formatNumber(e.count)}</strong> <span style="opacity:0.85;">${escapeHtml(e.label)}</span></span>`;
    })
    .join('');
  return `<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">Por estado</p>
    <p style="margin:0 0 20px 0;line-height:1.6;">${chips}</p>`;
}

function buildBreakdownHtml(title, entries) {
  const list = Object.values(entries || {}).filter((e) => e.count > 0);
  if (!list.length) return '';
  const chips = list
    .map(
      (e) =>
        `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 14px;font-size:13px;background:#fff;border:1px solid ${COLORS.border};border-radius:999px;color:${COLORS.textPrimary};"><strong>${formatNumber(e.count)}</strong> <span style="color:${COLORS.textSecondary};">${escapeHtml(e.label)}</span></span>`,
    )
    .join('');
  return `<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(title)}</p>
    <p style="margin:0 0 20px 0;line-height:1.6;">${chips}</p>`;
}

/**
 * Asunto pensado para envío manual el día de término de la prueba gratuita.
 */
function buildOrganizationPeriodSummarySubject(summary) {
  const orgName = displayOrgName(summary?.organizationName);
  const n = summary?.totals?.reservations ?? 0;
  const endsPhrase = summary?.trial?.endsPhrase;

  if (endsPhrase === 'hoy') {
    if (n > 0) {
      const word = n === 1 ? 'reserva' : 'reservas';
      return `Tu prueba gratuita termina hoy — ${n} ${word} con SimpleReserva`;
    }
    return `Tu prueba gratuita termina hoy — ${orgName}`;
  }

  if (n > 0) {
    const word = n === 1 ? 'reserva' : 'reservas';
    return `Tu prueba gratuita termina ${endsPhrase ?? 'pronto'} — ${n} ${word} con SimpleReserva`;
  }

  return `Tu prueba gratuita termina ${endsPhrase ?? 'pronto'} — activa tu plan`;
}

function buildOrganizationPeriodSummaryPreheader(summary) {
  const n = summary?.totals?.reservations ?? 0;
  const covers = summary?.totals?.covers ?? 0;
  const endsPhrase = summary?.trial?.endsPhrase ?? 'pronto';
  if (n > 0) {
    return `Termina ${endsPhrase}: ${n} reservas y ${formatNumber(covers)} comensales en tu prueba. Activa tu plan para seguir.`;
  }
  return `Tu prueba gratuita termina ${endsPhrase}. Revisa tu resumen y activa tu plan para no perder el panel.`;
}

function buildOrganizationPeriodSummaryHtml(options) {
  const {
    summary,
    recipientName,
    panelUrl,
    assetBaseUrl = '',
    personalNote = '',
  } = options;

  const orgName = escapeHtml(displayOrgName(summary.organizationName));
  const safePanelUrl = escapeHtml(panelUrl);
  const total = summary.totals.reservations;
  const covers = summary.totals.covers;
  const hasTrial = Boolean(summary.trial);
  const endsPhrase = hasTrial ? escapeHtml(summary.trial.endsPhrase) : null;
  const trialDays = summary.trial?.trialDays;

  const noteBlock =
    personalNote && String(personalNote).trim()
      ? `<p style="margin:0 0 20px 0;padding:12px 16px;background:#fff;border-left:3px solid ${COLORS.primary600};font-size:14px;color:${COLORS.textSecondary};font-style:italic;">${escapeHtml(String(personalNote).trim())}</p>`
      : '';

  const emptyState =
    total === 0
      ? `<p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">En la prueba aún no registramos reservas en el sistema. Activar tu plan deja listos el enlace y el panel para cuando lleguen.</p>`
      : '';

  const statsRow =
    total > 0
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
          <tr>${statCard('En tu prueba', formatNumber(total), 'reservas')}${statCard('Comensales', formatNumber(covers), summary.totals.avgPartySize ? `prom. ${summary.totals.avgPartySize} por mesa` : '')}</tr>
        </table>`
      : '';

  const trialDaysLabel = trialDays && trialDays > 0
    ? `${trialDays} día${trialDays === 1 ? '' : 's'}`
    : null;

  const introParagraph = hasTrial
    ? `Tu prueba gratuita termina <strong style="color:${COLORS.textPrimary};">${endsPhrase}</strong>.${trialDaysLabel ? ` En estos ${trialDaysLabel}, esto es lo que <strong style="color:${COLORS.textPrimary};">${orgName}</strong> logró con SimpleReserva:` : ` Esto es lo que lograste con SimpleReserva durante la prueba:`}`
    : `Aquí está el resumen de <strong style="color:${COLORS.textPrimary};">${orgName}</strong> en SimpleReserva.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola <strong>${orgName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      ${introParagraph}
    </p>
    ${noteBlock}
    ${emptyState}
    ${statsRow}
    ${buildHighlightsHtml(summary.highlights)}
    ${summary.growthProjections?.length ? `<p style="margin:0 0 10px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">Si continúas con SimpleReserva</p>` : ''}
    ${buildGrowthProjectionsHtml(summary.growthProjections)}
    ${buildProjectionHtml(summary.projection)}
    ${buildStatusBreakdownHtml(summary.byStatus)}
    ${buildBreakdownHtml('Por canal', summary.bySource)}
    ${buildRestaurantTableHtml(summary.byRestaurant)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:8px;">
      <tr>
        <td align="center">
          <a href="${safePanelUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Continuar con SimpleReserva</a>
        </td>
      </tr>
    </table>
    <p style="margin:16px 0 0 0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
      ¿Dudas sobre el plan? Responde este correo y te ayudamos.
    </p>`;

  const headline =
    total > 0
      ? `${formatNumber(total)} reserva${total === 1 ? '' : 's'} en tu prueba`
      : 'Tu prueba gratuita termina';

  const preheader = buildOrganizationPeriodSummaryPreheader(summary);

  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FIN DE PRUEBA GRATUITA',
    headline,
    preheader,
  });

  return wrapEmailDocument({
    title: buildOrganizationPeriodSummarySubject(summary),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildOrganizationPeriodSummaryHtml,
  buildOrganizationPeriodSummarySubject,
  buildOrganizationPeriodSummaryPreheader,
};
