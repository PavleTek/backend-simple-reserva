'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { createRecoveryPaymentLink } = require('../services/billing/recoveryLinkService');
const {
  BILLING_EMAIL_KINDS,
  sendBillingEmail,
  periodKeyFromGrace,
  shouldSendGraceLastChance,
} = require('../services/billing/billingEmailService');
const { billingUrl } = require('../utils/restaurantPanelUrl');

const CRON = process.env.LAST_CHANCE_LINK_CRON || '0 8 * * *';
const HOURS_BEFORE_EXPIRY = Number(process.env.LAST_CHANCE_HOURS_BEFORE_EXPIRY || 24);

async function runLastChanceLinkJob() {
  const threshold = new Date(Date.now() + HOURS_BEFORE_EXPIRY * 60 * 60 * 1000);

  const subs = await prisma.subscription.findMany({
    where: {
      status: 'grace',
      gracePeriodEndsAt: { lte: threshold, gt: new Date() },
      isActiveSubscription: true,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, email: true } },
        },
      },
    },
  });

  let sent = 0;
  for (const sub of subs) {
    const ownerId = sub.organization?.owner?.id;
    const ownerEmail = sub.organization?.owner?.email;
    if (!ownerId || !ownerEmail) continue;

    const periodKey = periodKeyFromGrace(sub.gracePeriodEndsAt);
    const eligible = await shouldSendGraceLastChance(sub.id, periodKey);
    if (!eligible) continue;

    const restaurant = await prisma.restaurant.findFirst({
      where: { organizationId: sub.organizationId, isDeleted: false },
      select: { id: true },
    });
    if (!restaurant) continue;

    try {
      let checkoutUrl = billingUrl();
      try {
        const link = await createRecoveryPaymentLink({
          organizationId: sub.organizationId,
          userId: ownerId,
          restaurantId: restaurant.id,
        });
        checkoutUrl = link.paymentUrl;
      } catch (linkErr) {
        logger.warn({ linkErr, orgId: sub.organizationId }, '[lastChanceLinkJob] recovery link failed');
      }

      const result = await sendBillingEmail({
        organizationId: sub.organizationId,
        subscriptionId: sub.id,
        kind: BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D,
        periodKey,
        toEmail: ownerEmail,
        orgName: sub.organization.name,
        gracePeriodEndsAt: sub.gracePeriodEndsAt,
        checkoutUrl,
        panelUrl: billingUrl(),
        metadata: { checkoutUrl },
      });

      if (result.sent) sent += 1;
    } catch (err) {
      logger.error({ err, orgId: sub.organizationId }, '[lastChanceLinkJob] send failed');
    }
  }

  logger.info({ sent }, '[lastChanceLinkJob] sent');
  return { sent };
}

function startLastChanceLinkJob() {
  cron.schedule(CRON, () => {
    runLastChanceLinkJob().catch((err) => logger.error({ err }, '[lastChanceLinkJob] cron error'));
  }, { timezone: 'America/Santiago' });
  logger.info({ schedule: CRON }, '[lastChanceLinkJob] scheduled');
}

module.exports = { startLastChanceLinkJob, runLastChanceLinkJob };
