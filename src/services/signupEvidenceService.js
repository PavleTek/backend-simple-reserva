const prisma = require('../lib/prisma');

const WELCOME_EMAIL_KIND = 'owner_welcome';
const WELCOME_EMAIL_SUBJECT = 'Bienvenido a SimpleReserva — tu cuenta está lista';

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.userId
 * @param {Date} [params.acceptedAt]
 * @param {string} params.termsVersion
 * @param {string|null} [params.signupIp]
 * @param {string|null} [params.signupUserAgent]
 * @param {import('@prisma/client').Prisma.TransactionClient} [params.tx]
 */
async function recordSignupEvidence({
  organizationId,
  userId,
  acceptedAt = new Date(),
  termsVersion,
  signupIp = null,
  signupUserAgent = null,
  tx,
}) {
  const db = tx || prisma;
  return db.restaurantOrganization.update({
    where: { id: organizationId },
    data: {
      signupRegisteredByUserId: userId,
      signupTermsAcceptedAt: acceptedAt,
      signupTermsVersion: termsVersion,
      signupIp,
      signupUserAgent,
    },
  });
}

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.recipientEmail
 * @param {'sent'|'failed'} [params.status]
 * @param {string|null} [params.resendId]
 * @param {Date|null} [params.sentAt]
 * @param {'live'|'backfill'} [params.source]
 * @param {object|null} [params.metadata]
 * @param {import('@prisma/client').Prisma.TransactionClient} [params.tx]
 */
async function logOwnerWelcomeEmail({
  organizationId,
  recipientEmail,
  status = 'sent',
  resendId = null,
  sentAt = new Date(),
  source = 'live',
  metadata = null,
  tx,
}) {
  const db = tx || prisma;
  return db.organizationSignupEmailLog.create({
    data: {
      organizationId,
      kind: WELCOME_EMAIL_KIND,
      recipientEmail: recipientEmail.toLowerCase().trim(),
      subject: WELCOME_EMAIL_SUBJECT,
      status,
      resendId,
      sentAt,
      source,
      metadata,
    },
  });
}

module.exports = {
  WELCOME_EMAIL_KIND,
  WELCOME_EMAIL_SUBJECT,
  recordSignupEvidence,
  logOwnerWelcomeEmail,
};
