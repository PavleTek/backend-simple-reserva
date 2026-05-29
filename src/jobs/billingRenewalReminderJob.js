'use strict';

/**
 * Recordatorios de renovación mensual (Checkout Pro / manual_monthly).
 * Envía correos a 7, 4 y 1 día antes de currentPeriodEnd.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');
const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');
const {
  parseRenewalReminderDays,
  msToDays,
  renewalKindFromDaysLeft,
  shouldSendRenewalReminder,
  sendBillingEmail,
  periodKeyFromPeriodEnd,
  createOpsAlert,
} = require('../services/billing/billingEmailService');
const { billingUrl } = require('../utils/restaurantPanelUrl');

async function runBillingRenewalReminders() {
  const reminderDays = parseRenewalReminderDays();
  if (reminderDays.length === 0) return { sent: 0 };

  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: {
      status: 'active',
      isActiveSubscription: true,
      billingStrategy: BILLING_STRATEGY_MANUAL,
      currentPeriodEnd: { not: null },
    },
    include: {
      plan: { select: { productSKU: true, name: true } },
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { email: true } },
          restaurants: { take: 1, select: { id: true } },
        },
      },
    },
  });

  let sent = 0;

  for (const sub of subs) {
    if (!sub.currentPeriodEnd) continue;
    const daysLeft = msToDays(new Date(sub.currentPeriodEnd).getTime() - now.getTime());
    if (!reminderDays.includes(daysLeft)) continue;

    const kind = renewalKindFromDaysLeft(daysLeft);
    if (!kind) continue;

    const eligible = await shouldSendRenewalReminder(sub, daysLeft);
    if (!eligible) continue;

    const restaurantId = sub.organization?.restaurants?.[0]?.id;
    const toEmail = sub.organization?.owner?.email;
    if (!restaurantId || !toEmail) continue;

    try {
      const { checkoutUrl } = await mercadopagoCheckoutProService.createRenewalPreference({
        organizationId: sub.organizationId,
        planSKU: sub.plan.productSKU,
        subscriptionId: sub.id,
        restaurantId,
      });

      const periodKey = periodKeyFromPeriodEnd(sub.currentPeriodEnd);
      const result = await sendBillingEmail({
        organizationId: sub.organizationId,
        subscriptionId: sub.id,
        kind,
        periodKey,
        toEmail,
        orgName: sub.organization.name,
        planName: sub.plan.name,
        periodEnd: sub.currentPeriodEnd,
        checkoutUrl,
        panelUrl: `${billingUrl()}?restaurantId=${restaurantId}`,
        daysLeft,
        isReferralFreeWindow: !!sub.referralFreeUntil,
        metadata: { checkoutUrl, daysLeft, referralFreeUntil: sub.referralFreeUntil },
      });

      if (result.sent) sent++;
    } catch (err) {
      logger.error({ err, subscriptionId: sub.id }, '[BillingRenewalReminderJob] failed');
      await createOpsAlert({
        organizationId: sub.organizationId,
        subscriptionId: sub.id,
        kind: 'renewal_link_failed',
        severity: 'critical',
        title: `Fallo al generar link de renovación — ${sub.organization.name}`,
        detail: err?.message || String(err),
        suggestedAction: 'Revisar MP / generar link manual desde admin.',
        dedupeKey: `org:${sub.organizationId}:renewal_link_failed:${periodKeyFromPeriodEnd(sub.currentPeriodEnd)}:${daysLeft}`,
      });
    }
  }

  if (sent > 0) {
    logger.info({ sent }, '[BillingRenewalReminderJob] renewal reminders sent');
  }
  return { sent };
}

function startBillingRenewalReminderJob() {
  const schedule = process.env.CHECKOUT_PRO_RENEWAL_CRON || '0 10 * * *';
  cron.schedule(schedule, () => {
    runBillingRenewalReminders().catch((err) => {
      logger.error({ err }, '[BillingRenewalReminderJob] cron error');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[BillingRenewalReminderJob] scheduled');
}

module.exports = { startBillingRenewalReminderJob, runBillingRenewalReminders };
