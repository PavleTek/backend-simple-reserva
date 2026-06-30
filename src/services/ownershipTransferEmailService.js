'use strict';

const { sendEmail } = require('./emailService');
const { resolveTransactionalFromEmail } = require('./notificationService');
const {
  buildTransferInvitationHtml,
  buildTransferInvitationSubject,
  buildTransferInitiatedNoticeHtml,
  buildTransferAcceptedNewOwnerHtml,
  buildTransferAcceptedOldOwnerHtml,
  buildTransferDeclinedHtml,
} = require('../templates/ownershipTransferEmail');

function getAssetBaseUrl() {
  return process.env.EMAIL_ASSET_BASE_URL || process.env.BACKEND_PUBLIC_URL || process.env.FRONTEND_LANDING_PAGE_URL || '';
}

function getPanelUrl() {
  const base = process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175';
  return `${base.replace(/\/$/, '')}/login`;
}

async function sendTransferInvitationEmail({ transfer, acceptUrl, invitedByName }) {
  const orgName = transfer.organization?.name || 'Organización';
  const html = buildTransferInvitationHtml({
    organizationName: orgName,
    invitedByName,
    acceptUrl,
    expiresAt: transfer.expiresAt,
    assetBaseUrl: getAssetBaseUrl(),
  });
  await sendEmail({
    fromEmail: await resolveTransactionalFromEmail(),
    toEmails: [transfer.targetEmail],
    subject: buildTransferInvitationSubject(orgName),
    content: html,
    isHtml: true,
  });
}

async function sendTransferInitiatedNoticeEmail({ transfer, orgName }) {
  const ownerEmail = transfer.fromOwner?.email;
  if (!ownerEmail) return;
  const html = buildTransferInitiatedNoticeHtml({
    organizationName: orgName,
    targetEmail: transfer.targetEmail,
    assetBaseUrl: getAssetBaseUrl(),
  });
  await sendEmail({
    fromEmail: await resolveTransactionalFromEmail(),
    toEmails: [ownerEmail],
    subject: `Transferencia iniciada — ${orgName}`,
    content: html,
    isHtml: true,
  });
}

async function sendTransferAcceptedEmails({ organizationName, newOwner, oldOwner, stayedAsManager = true }) {
  const fromEmail = await resolveTransactionalFromEmail();
  const panelUrl = getPanelUrl();

  await sendEmail({
    fromEmail,
    toEmails: [newOwner.email],
    subject: `Ahora eres propietario — ${organizationName}`,
    content: buildTransferAcceptedNewOwnerHtml({
      organizationName,
      panelUrl,
      assetBaseUrl: getAssetBaseUrl(),
    }),
    isHtml: true,
  });

  if (oldOwner?.email) {
    await sendEmail({
      fromEmail,
      toEmails: [oldOwner.email],
      subject: `Transferencia completada — ${organizationName}`,
      content: buildTransferAcceptedOldOwnerHtml({
        organizationName,
        targetEmail: newOwner.email,
        stayedAsManager,
        assetBaseUrl: getAssetBaseUrl(),
      }),
      isHtml: true,
    });
  }
}

async function sendTransferDeclinedEmail({ transfer }) {
  const ownerEmail = transfer.fromOwner?.email;
  if (!ownerEmail) return;
  const orgName = transfer.organization?.name || 'Organización';
  await sendEmail({
    fromEmail: await resolveTransactionalFromEmail(),
    toEmails: [ownerEmail],
    subject: `Transferencia rechazada — ${orgName}`,
    content: buildTransferDeclinedHtml({
      organizationName: orgName,
      targetEmail: transfer.targetEmail,
      assetBaseUrl: getAssetBaseUrl(),
    }),
    isHtml: true,
  });
}

async function sendTransferCancelledEmail() {
  // Reserved for future use; cancellation is owner-initiated in-panel.
}

module.exports = {
  sendTransferInvitationEmail,
  sendTransferInitiatedNoticeEmail,
  sendTransferAcceptedEmails,
  sendTransferDeclinedEmail,
  sendTransferCancelledEmail,
};
