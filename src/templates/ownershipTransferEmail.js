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

function buildButton(label, href) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
    <tr>
      <td align="center" style="border-radius:8px;background-color:${COLORS.primary600};">
        <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function buildTransferInvitationHtml({ organizationName, invitedByName, acceptUrl, expiresAt, assetBaseUrl = '' }) {
  const preheader = `${invitedByName} quiere transferirte la propiedad de ${organizationName}`;
  const { safePreheader, headerHtml } = buildEmailHeaderBlock({
    assetBaseUrl,
    eyebrow: 'Transferencia de propiedad',
    headline: 'Invitación para ser propietario',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;"><strong>${escapeHtml(invitedByName)}</strong> quiere transferirte la propiedad de <strong>${escapeHtml(organizationName)}</strong> en SimpleReserva.</p>
    <p style="margin:0 0 16px 0;">Como propietario podrás gestionar facturación, equipo y configuración de la organización.</p>
    ${buildButton('Revisar y aceptar', acceptUrl)}
    <p style="margin:0;font-size:14px;color:${COLORS.textSecondary};">Esta invitación expira el ${escapeHtml(formatExpiryDate(expiresAt))}.</p>`;
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
    eyebrow: 'Seguridad',
    headline: 'Transferencia iniciada',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">Confirmamos que iniciaste una transferencia de propiedad de <strong>${escapeHtml(organizationName)}</strong> hacia <strong>${escapeHtml(targetEmail)}</strong>.</p>
    <p style="margin:0 0 16px 0;">La propiedad se transferirá solo cuando esa persona acepte la invitación. Si no fuiste tú, cancela la transferencia desde Ajustes de tu cuenta en el panel.</p>`;
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
    eyebrow: 'Propiedad transferida',
    headline: 'Ahora eres propietario',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">La propiedad de <strong>${escapeHtml(organizationName)}</strong> fue transferida a tu cuenta.</p>
    <p style="margin:0 0 16px 0;"><strong>Importante:</strong> revisa tus datos de facturación y método de pago en el panel para asegurarte de que todo esté correcto.</p>
    ${buildButton('Ir al panel', panelUrl)}`;
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
    eyebrow: 'Transferencia completada',
    headline: 'Propiedad transferida',
    preheader,
  });
  const afterText = stayedAsManager
    ? 'Conservas acceso como gerente de la organización.'
    : 'Ya no tienes acceso a esta organización.';
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">La propiedad de <strong>${escapeHtml(organizationName)}</strong> fue transferida a <strong>${escapeHtml(targetEmail)}</strong>.</p>
    <p style="margin:0;">${escapeHtml(afterText)}</p>`;
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
    eyebrow: 'Transferencia',
    headline: 'Invitación rechazada',
    preheader,
  });
  const bodyHtml = `<p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0;">${escapeHtml(targetEmail)} rechazó la transferencia de propiedad de <strong>${escapeHtml(organizationName)}</strong>. Sigues siendo el propietario.</p>`;
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
