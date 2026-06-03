'use strict';

const { sendEmail } = require('../emailService');
const { billingUrl } = require('../../utils/restaurantPanelUrl');

function getAssetBaseUrl() {
  return process.env.EMAIL_ASSET_BASE_URL || process.env.BACKEND_PUBLIC_URL || '';
}

async function resolveFromEmail() {
  const notificationService = require('../notificationService');
  if (typeof notificationService.resolveTransactionalFromEmail === 'function') {
    return notificationService.resolveTransactionalFromEmail();
  }
  return process.env.RESEND_FROM_EMAIL || 'billing@simplereserva.cl';
}

async function getOwnerEmails(organizationId) {
  const org = await require('../../lib/prisma').restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { owner: { select: { email: true } } },
  });
  return org?.owner?.email ? [org.owner.email] : [];
}

async function sendPaymentApprovedEmail({ organizationId, planName, amountCLP, currency, pdfBuffer }) {
  const prisma = require('../../lib/prisma');
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, owner: { select: { email: true } } },
  });
  const emails = org?.owner?.email ? [org.owner.email] : [];
  if (!emails.length) return false;

  const {
    buildPaymentApprovedHtml,
    buildPaymentApprovedSubject,
  } = require('../../templates/paymentApprovedEmail');

  const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;
  const html = buildPaymentApprovedHtml({
    restaurantName: org.name,
    planName,
    amountCLP,
    currency,
    panelUrl,
    assetBaseUrl: getAssetBaseUrl(),
  });

  const attachments = pdfBuffer
    ? [{ filename: 'comprobante-pago.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
    : [];

  await sendEmail({
    fromEmail: await resolveFromEmail(),
    toEmails: emails,
    subject: buildPaymentApprovedSubject(org.name),
    content: html,
    isHtml: true,
    attachments,
  });
  return true;
}

async function sendSubscriptionCancelledEmail({ organizationId, endDate }) {
  const prisma = require('../../lib/prisma');
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, owner: { select: { email: true } } },
  });
  const emails = org?.owner?.email ? [org.owner.email] : [];
  if (!emails.length) return false;

  const {
    buildSubscriptionCancelledHtml,
    buildSubscriptionCancelledSubject,
  } = require('../../templates/subscriptionCancelledEmail');

  const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;
  const endLabel = endDate ? new Date(endDate).toLocaleDateString('es-CL') : 'fin del periodo';

  await sendEmail({
    fromEmail: await resolveFromEmail(),
    toEmails: emails,
    subject: buildSubscriptionCancelledSubject(org.name),
    content: buildSubscriptionCancelledHtml({
      restaurantName: org.name,
      endDate: endLabel,
      panelUrl,
      assetBaseUrl: getAssetBaseUrl(),
    }),
    isHtml: true,
  });
  return true;
}

async function sendPlanChangeScheduledEmail({ organizationId, planName, scheduledDate, amountCLP }) {
  const prisma = require('../../lib/prisma');
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, owner: { select: { email: true } } },
  });
  const emails = org?.owner?.email ? [org.owner.email] : [];
  if (!emails.length) return false;

  const {
    buildPlanChangeScheduledHtml,
    buildPlanChangeScheduledSubject,
  } = require('../../templates/planChangeEmail');

  const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;

  await sendEmail({
    fromEmail: await resolveFromEmail(),
    toEmails: emails,
    subject: buildPlanChangeScheduledSubject(planName),
    content: buildPlanChangeScheduledHtml({
      restaurantName: org.name,
      planName,
      scheduledDate: new Date(scheduledDate).toLocaleDateString('es-CL'),
      amountCLP,
      panelUrl,
      assetBaseUrl: getAssetBaseUrl(),
    }),
    isHtml: true,
  });
  return true;
}

async function sendPlanChangeAppliedEmail({ organizationId, planName }) {
  const prisma = require('../../lib/prisma');
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, owner: { select: { email: true } } },
  });
  const emails = org?.owner?.email ? [org.owner.email] : [];
  if (!emails.length) return false;

  const {
    buildPlanChangeAppliedHtml,
    buildPlanChangeAppliedSubject,
  } = require('../../templates/planChangeEmail');

  const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;

  await sendEmail({
    fromEmail: await resolveFromEmail(),
    toEmails: emails,
    subject: buildPlanChangeAppliedSubject(planName),
    content: buildPlanChangeAppliedHtml({
      restaurantName: org.name,
      planName,
      panelUrl,
      assetBaseUrl: getAssetBaseUrl(),
    }),
    isHtml: true,
  });
  return true;
}

module.exports = {
  sendPaymentApprovedEmail,
  sendSubscriptionCancelledEmail,
  sendPlanChangeScheduledEmail,
  sendPlanChangeAppliedEmail,
  getOwnerEmails,
};
