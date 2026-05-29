'use strict';

/**
 * Suscripciones manual_monthly activas con currentPeriodEnd vencido → periodo de gracia + correo.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { enterGracePeriod } = require('../services/mercadopagoService');
const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');
const { createRecoveryPaymentLink } = require('../services/billing/recoveryLinkService');
const {
  BILLING_EMAIL_KINDS,
  sendBillingEmail,
  periodKeyFromPeriodEnd,
  createOpsAlert,
  hasBillingEmailLog,
} = require('../services/billing/billingEmailService');
const { billingUrl } = require('../utils/restaurantPanelUrl');

async function processOverdueSubscription(sub) {
  const org = sub.organization;
  const ownerId = org?.owner?.id;
  const ownerEmail = org?.owner?.email;
  const restaurantId = org?.restaurants?.[0]?.id;
  const periodKey = periodKeyFromPeriodEnd(sub.currentPeriodEnd);

  await enterGracePeriod(sub.organizationId, { skipOwnerEmail: true });

  const updated = await prisma.subscription.findFirst({
    where: { organizationId: sub.organizationId, status: 'grace' },
    include: { plan: true },
  });

  if (!updated) {
    logger.warn({ subscriptionId: sub.id }, '[ManualPeriodOverdueJob] grace sub not found after enterGracePeriod');
    return false;
  }

  let checkoutUrl = billingUrl();
  if (ownerId && restaurantId) {
    try {
      const link = await createRecoveryPaymentLink({
        organizationId: sub.organizationId,
        userId: ownerId,
        restaurantId,
      });
      checkoutUrl = link.paymentUrl;
    } catch (err) {
      logger.warn({ err, orgId: sub.organizationId }, '[ManualPeriodOverdueJob] recovery link failed');
    }
  }

  if (!(await hasBillingEmailLog(updated.id, BILLING_EMAIL_KINDS.PERIOD_OVERDUE, periodKey))) {
    if (ownerEmail) {
      await sendBillingEmail({
        organizationId: sub.organizationId,
        subscriptionId: updated.id,
        kind: BILLING_EMAIL_KINDS.PERIOD_OVERDUE,
        periodKey,
        toEmail: ownerEmail,
        orgName: org.name,
        planName: updated.plan?.name || sub.plan?.name || 'Plan',
        periodEnd: sub.currentPeriodEnd,
        gracePeriodEndsAt: updated.gracePeriodEndsAt,
        checkoutUrl,
        panelUrl: billingUrl(),
        metadata: { checkoutUrl },
      });
    }
  }

  await createOpsAlert({
    organizationId: sub.organizationId,
    subscriptionId: updated.id,
    kind: 'period_overdue',
    severity: 'warning',
    title: `Periodo vencido sin pago — ${org.name}`,
    detail: `currentPeriodEnd=${sub.currentPeriodEnd?.toISOString?.()}`,
    suggestedAction: 'Contactar al cliente; enviar link de recovery desde admin si hace falta.',
    dedupeKey: `org:${sub.organizationId}:period_overdue:${periodKey}`,
  });

  return true;
}

async function runManualPeriodOverdue() {
  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: {
      status: 'active',
      isActiveSubscription: true,
      billingStrategy: BILLING_STRATEGY_MANUAL,
      currentPeriodEnd: { lt: now },
    },
    include: {
      plan: { select: { name: true } },
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, email: true } },
          restaurants: { take: 1, select: { id: true } },
        },
      },
    },
  });

  let processed = 0;
  for (const sub of subs) {
    try {
      const ok = await processOverdueSubscription(sub);
      if (ok) processed++;
    } catch (err) {
      logger.error({ err, subscriptionId: sub.id }, '[ManualPeriodOverdueJob] failed');
    }
  }

  if (processed > 0) {
    logger.info({ processed }, '[ManualPeriodOverdueJob] overdue subscriptions processed');
  }
  return { processed };
}

function startManualPeriodOverdueJob() {
  const schedule = process.env.MANUAL_PERIOD_OVERDUE_CRON || '30 1 * * *';
  cron.schedule(schedule, () => {
    runManualPeriodOverdue().catch((err) => {
      logger.error({ err }, '[ManualPeriodOverdueJob] cron error');
    });
  }, { timezone: process.env.TZ || 'America/Santiago' });
  logger.info({ schedule }, '[ManualPeriodOverdueJob] scheduled');
}

module.exports = { startManualPeriodOverdueJob, runManualPeriodOverdue, processOverdueSubscription };
