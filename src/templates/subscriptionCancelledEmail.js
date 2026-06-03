'use strict';

const {
  COLORS,
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
} = require('./emailLayout');

function buildSubscriptionCancelledSubject(restaurantName) {
  return `Suscripción cancelada — ${restaurantName}`;
}

function buildSubscriptionCancelledHtml({ restaurantName, endDate, panelUrl, assetBaseUrl = '' }) {
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Confirmamos la cancelación de tu suscripción para
      <strong>${escapeHtml(restaurantName)}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Mantienes acceso hasta el <strong>${escapeHtml(endDate)}</strong>. No se realizarán más cobros después de esa fecha.
    </p>
    <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
      Puedes reactivar antes de esa fecha desde facturación.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <a href="${escapeHtml(panelUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};">Ir a facturación</a>
      </td></tr>
    </table>`;

  const preheader = `Acceso hasta ${endDate}.`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'FACTURACIÓN',
    headline: 'Suscripción cancelada',
    preheader,
  });

  return wrapEmailDocument({
    title: buildSubscriptionCancelledSubject(restaurantName),
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildSubscriptionCancelledSubject,
  buildSubscriptionCancelledHtml,
};
