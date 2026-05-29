'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

function buildPlanChangeScheduledSubject(planName) {
  return `Cambio de plan programado — ${planName}`;
}

function buildPlanChangeScheduledHtml({ restaurantName, planName, scheduledDate, amountCLP, panelUrl, assetBaseUrl = '' }) {
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Programaste el cambio al plan <strong>${escapeHtml(planName)}</strong> para
      <strong>${escapeHtml(restaurantName)}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Se aplicará el <strong>${escapeHtml(scheduledDate)}</strong>.
      Cobro estimado: <strong>$${escapeHtml(String(amountCLP))} CLP</strong> (más IVA).
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ver detalle</a>
      </td></tr>
    </table>`;

  const preheader = `Cambio al plan ${planName} el ${scheduledDate}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Cambio programado',
    preheader,
  });

  return wrapEmailDocument({
    title: buildPlanChangeScheduledSubject(planName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

function buildPlanChangeAppliedSubject(planName) {
  return `Tu plan cambió a ${planName}`;
}

function buildPlanChangeAppliedHtml({ restaurantName, planName, panelUrl, assetBaseUrl = '' }) {
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Tu plan en <strong>${escapeHtml(restaurantName)}</strong> ahora es
      <strong>${escapeHtml(planName)}</strong>.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ver facturación</a>
      </td></tr>
    </table>`;

  const preheader = `Plan activo: ${planName}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Cambio aplicado',
    preheader,
  });

  return wrapEmailDocument({
    title: buildPlanChangeAppliedSubject(planName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildPlanChangeScheduledSubject,
  buildPlanChangeScheduledHtml,
  buildPlanChangeAppliedSubject,
  buildPlanChangeAppliedHtml,
};
