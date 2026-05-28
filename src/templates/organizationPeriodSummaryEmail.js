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
        `<li style="margin:0 0 8px 0;color:${COLORS.textSecondary};font-size:14px;line-height:1.45;">${escapeHtml(h)}</li>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
    <tr><td style="padding:14px 18px;background:linear-gradient(135deg,#faf0f1 0%,#f5f4f0 100%);border:1px solid ${COLORS.border};border-radius:12px;">
      <p style="margin:0 0 10px 0;font-size:13px;font-weight:700;color:${COLORS.primary600};">Durante tu prueba gratuita</p>
      <ul style="margin:0;padding-left:20px;">${items}</ul>
    </td></tr>
  </table>`;
}

function buildProjectionHtml(projection) {
  if (!projection?.lines?.length && !projection?.callout) return '';
  const lines = (projection.lines || [])
    .map(
      (line) =>
        `<li style="margin:0 0 10px 0;color:${COLORS.textPrimary};font-size:14px;line-height:1.5;">${escapeHtml(line)}</li>`,
    )
    .join('');
  const callout = projection.callout
    ? `<p style="margin:12px 0 0 0;padding:12px 14px;font-size:14px;line-height:1.5;color:${COLORS.textPrimary};background:#fff;border-radius:10px;border:1px solid ${COLORS.primary600};"><strong style="color:${COLORS.primary600};">Siguiente paso:</strong> ${escapeHtml(projection.callout)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
    <tr><td style="padding:14px 18px;background-color:#fff;border:1px solid ${COLORS.border};border-radius:12px;">
      <p style="margin:0 0 10px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">Si activas tu plan</p>
      <ul style="margin:0;padding-left:20px;">${lines}</ul>
      ${callout}
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

function buildBreakdownHtml(title, entries) {
  const list = Object.values(entries || {}).filter((e) => e.count > 0);
  if (!list.length) return '';
  const chips = list
    .map(
      (e) =>
        `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 12px;font-size:13px;background:#fff;border:1px solid ${COLORS.border};border-radius:999px;color:${COLORS.textPrimary};"><strong>${formatNumber(e.count)}</strong> <span style="color:${COLORS.textSecondary};">${escapeHtml(e.label)}</span></span>`,
    )
    .join('');
  return `<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:${COLORS.textSecondary};text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(title)}</p>
    <p style="margin:0 0 20px 0;line-height:1.6;">${chips}</p>`;
}

/**
 * Asunto pensado para envío manual el día de término de la prueba gratuita.
 */
function buildOrganizationPeriodSummarySubject(summary) {
  const orgName = summary?.organizationName ?? 'tu restaurante';
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

  const orgName = escapeHtml(summary.organizationName);
  const periodLabel = escapeHtml(summary.period.label);
  const safeName = escapeHtml(recipientName || 'equipo');
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

  const trialIntro = trialDays
    ? `En ${trialDays} día${trialDays === 1 ? '' : 's'} de prueba`
    : 'Durante tu prueba gratuita';

  const introParagraph = hasTrial
    ? `Tu prueba gratuita de <strong style="color:${COLORS.textPrimary};">SimpleReserva</strong> en
      <strong style="color:${COLORS.textPrimary};">${orgName}</strong> termina <strong style="color:${COLORS.textPrimary};">${endsPhrase}</strong>.
      ${trialIntro}, esto es lo que el sistema hizo por ti (${periodLabel}).`
    : `Este es el resumen de <strong style="color:${COLORS.textPrimary};">${orgName}</strong> en SimpleReserva para
      <strong style="color:${COLORS.textPrimary};">${periodLabel}</strong>.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola ${safeName},</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      ${introParagraph}
    </p>
    ${noteBlock}
    ${emptyState}
    ${statsRow}
    ${buildHighlightsHtml(summary.highlights)}
    ${buildProjectionHtml(summary.projection)}
    ${buildBreakdownHtml('Por estado', summary.byStatus)}
    ${buildBreakdownHtml('Por canal', summary.bySource)}
    ${buildRestaurantTableHtml(summary.byRestaurant)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:8px;">
      <tr>
        <td align="center">
          <a href="${safePanelUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Activar plan y seguir</a>
        </td>
      </tr>
    </table>
    <p style="margin:16px 0 0 0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
      Sin un plan activo, el enlace de reservas y el panel dejan de estar disponibles al terminar la prueba.
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
