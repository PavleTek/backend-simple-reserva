'use strict';

const {
  escapeHtml,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
  COLORS,
} = require('./emailLayout');

function formatExpiryDate(date) {
  return new Date(date).toLocaleDateString('es-CL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function buildCenteredButton(label, href) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
    <tr>
      <td align="center" style="text-align:center;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr>
            <td align="center" style="border-radius:12px;background-color:${COLORS.primary600};">
              <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function buildInfoBox(content) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
    <tr><td style="padding:16px 18px;background-color:#faf0f1;border:1px solid ${COLORS.border};border-radius:12px;text-align:center;">
      ${content}
    </td></tr>
  </table>`;
}

function buildTransferInvitationHtml({ organizationName, invitedByName, acceptUrl, expiresAt, assetBaseUrl = '' }) {
  const preheader = `${invitedByName} quiere transferirte la propiedad de ${organizationName}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'TRANSFERENCIA DE PROPIEDAD',
    headline: 'Invitación para ser propietario',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;text-align:center;">Hola,</p>
    ${buildInfoBox(`
      <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textMuted};">Organización</p>
      <p style="margin:0;font-size:18px;font-weight:700;color:${COLORS.textPrimary};">${escapeHtml(organizationName)}</p>
      <p style="margin:12px 0 0 0;font-size:14px;color:${COLORS.textSecondary};">
        Invitado por <strong style="color:${COLORS.textPrimary};">${escapeHtml(invitedByName)}</strong>
      </p>
    `)}
    <p style="margin:0 0 16px 0;color:${COLORS.textSecondary};text-align:center;">
      Como propietario podrás gestionar facturación, equipo y configuración de la organización.
    </p>
    ${buildCenteredButton('Revisar y aceptar', acceptUrl)}
    <p style="margin:0;font-size:13px;color:${COLORS.textMuted};text-align:center;">
      Esta invitación expira el ${escapeHtml(formatExpiryDate(expiresAt))}.
    </p>`;
  return wrapEmailDocument({
    title: `Transferencia de propiedad — ${organizationName}`,
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

function buildTransferInvitationSubject(organizationName) {
  return `Transferencia de propiedad — ${organizationName}`;
}

function buildTransferInitiatedNoticeHtml({ organizationName, targetEmail, assetBaseUrl = '' }) {
  const preheader = `Iniciaste una transferencia de ${organizationName} a ${targetEmail}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'SEGURIDAD',
    headline: 'Transferencia iniciada',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;color:${COLORS.textSecondary};">Confirmamos que iniciaste una transferencia de propiedad de <strong>${escapeHtml(organizationName)}</strong> hacia <strong>${escapeHtml(targetEmail)}</strong>.</p>
    <p style="margin:0;color:${COLORS.textSecondary};">La propiedad se transferirá solo cuando esa persona acepte la invitación. Si no fuiste tú, cancela la transferencia desde Ajustes de tu cuenta en el panel.</p>`;
  return wrapEmailDocument({
    title: 'Transferencia de propiedad iniciada',
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

function buildTransferAcceptedNewOwnerHtml({ organizationName, panelUrl, assetBaseUrl = '' }) {
  const preheader = `Ahora eres propietario de ${organizationName}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'PROPIEDAD TRANSFERIDA',
    headline: 'Ahora eres propietario',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;text-align:center;">Hola,</p>
    <p style="margin:0 0 16px 0;color:${COLORS.textSecondary};text-align:center;">La propiedad de <strong>${escapeHtml(organizationName)}</strong> fue transferida a tu cuenta.</p>
    <p style="margin:0 0 16px 0;color:${COLORS.textSecondary};text-align:center;"><strong>Importante:</strong> revisa tus datos de facturación y método de pago en el panel para asegurarte de que todo esté correcto.</p>
    ${buildCenteredButton('Ir al panel', panelUrl)}`;
  return wrapEmailDocument({
    title: `Propiedad transferida — ${organizationName}`,
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

function buildTransferAcceptedOldOwnerHtml({ organizationName, targetEmail, stayedAsManager, assetBaseUrl = '' }) {
  const preheader = `Transferiste la propiedad de ${organizationName}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'TRANSFERENCIA COMPLETADA',
    headline: 'Propiedad transferida',
    preheader,
  });
  const afterText = stayedAsManager
    ? 'Conservas acceso como gerente de la organización.'
    : 'Ya no tienes acceso a esta organización.';
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;color:${COLORS.textSecondary};">La propiedad de <strong>${escapeHtml(organizationName)}</strong> fue transferida a <strong>${escapeHtml(targetEmail)}</strong>.</p>
    <p style="margin:0;color:${COLORS.textSecondary};">${escapeHtml(afterText)}</p>`;
  return wrapEmailDocument({
    title: `Transferencia completada — ${organizationName}`,
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

function buildTransferDeclinedHtml({ organizationName, targetEmail, assetBaseUrl = '' }) {
  const preheader = `${targetEmail} rechazó la transferencia de ${organizationName}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'TRANSFERENCIA',
    headline: 'Invitación rechazada',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0;color:${COLORS.textSecondary};">${escapeHtml(targetEmail)} rechazó la transferencia de propiedad de <strong>${escapeHtml(organizationName)}</strong>. Sigues siendo el propietario.</p>`;
  return wrapEmailDocument({
    title: `Transferencia rechazada — ${organizationName}`,
    preheader,
    safePreheader,
    headerHtml,
    bodyHtml,
    footerHtml: buildEmailFooter(),
  });
}

module.exports = {
  buildTransferInvitationHtml,
  buildTransferInvitationSubject,
  buildTransferInitiatedNoticeHtml,
  buildTransferAcceptedNewOwnerHtml,
  buildTransferAcceptedOldOwnerHtml,
  buildTransferDeclinedHtml,
};
