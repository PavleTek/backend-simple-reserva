/**
 * Sends trial reminder emails at 7 days and 2 days before trial end.
 * Runs daily at 09:00 Chile time.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { sendEmail } = require('../services/emailService');
const { isTrialing } = require('../services/subscriptionService');
const planService = require('../services/planService');
const { buildTrialReminderHtml, buildTrialReminderSubject } = require('../templates/trialReminderEmail');
const { CONTACT_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_HREF } = require('../config/contact');
const { BILLING_EMAIL_KINDS, hasBillingEmailLog } = require('../services/billing/billingEmailService');
const { withCronLock } = require('../lib/cronLock');

const RESTAURANT_PORTAL_URL = process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175';

/**
 * Origin for logo image in HTML emails (same env as public booking site).
 */
function getAssetBaseUrl() {
  return (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
}

function formatPriceCLP(amount) {
  if (amount == null) return '$4,990 CLP';
  return `$${Number(amount).toLocaleString('es-CL')} CLP`;
}

function msToDays(ms) {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function runTrialReminders() {
  const organizations = await prisma.restaurantOrganization.findMany({
    where: {
      trialEndsAt: { not: null },
      isDeleted: false,
    },
    include: {
      owner: { select: { id: true, email: true, name: true } },
      restaurants: {
        select: {
          id: true,
          name: true,
          _count: { select: { reservations: true } },
        }
      }
    },
  });

  let sent = 0;
  const now = new Date();

  for (const org of organizations) {
    const inTrial = await isTrialing(org.id);
    if (!inTrial) continue;

    const trialEndsAt = org.trialEndsAt;
    if (!trialEndsAt) continue;

    const daysLeft = msToDays(trialEndsAt.getTime() - now.getTime());

    // Use window-based matching: 7d bucket covers 5–8 days, 2d bucket covers 1–3 days
    let reminderKind = null;
    if (daysLeft >= 5 && daysLeft <= 8) {
      reminderKind = BILLING_EMAIL_KINDS.TRIAL_7D;
    } else if (daysLeft >= 1 && daysLeft <= 3) {
      reminderKind = BILLING_EMAIL_KINDS.TRIAL_2D;
    }
    if (!reminderKind) continue;

    // Dedup via BillingEmailLog — find the active trial subscription for this org
    const trialSub = await prisma.subscription.findFirst({
      where: { organizationId: org.id, status: 'trial', isActiveSubscription: true },
      orderBy: { startDate: 'desc' },
      select: { id: true },
    });
    if (trialSub) {
      const periodKey = trialEndsAt.toISOString().slice(0, 10);
      const alreadySent = await hasBillingEmailLog(trialSub.id, reminderKind, periodKey);
      if (alreadySent) continue;
    }

    const ownerId = org.ownerId;
    const planConfig = ownerId ? await planService.resolvePlanConfig(ownerId, true) : null;
    const priceStr = formatPriceCLP(planConfig?.priceCLP);

    const config = await prisma.configuration.findFirst();
    const fromSender = config?.recoveryEmailSenderId
      ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
      : null;
    const fromEmail = fromSender || 'noreply@simplereserva.com';

    const panelUrl = `${RESTAURANT_PORTAL_URL.replace(/\/$/, '')}/billing`;
    const bucketDays = reminderKind === BILLING_EMAIL_KINDS.TRIAL_7D ? 7 : 2;
    const subject = buildTrialReminderSubject(bucketDays);

    // If multiple restaurants, we use the first one for the name in the email, or just the organization name
    const restaurantName = org.restaurants[0]?.name || org.name;
    const reservationCount = org.restaurants.reduce((acc, r) => acc + r._count.reservations, 0);

    const ownerName = org.owner?.name || org.owner?.email || '';
    const html = buildTrialReminderHtml({
      ownerName,
      restaurantName,
      daysLeft: bucketDays,
      reservationCount,
      priceStr,
      panelUrl,
      contactEmail: CONTACT_EMAIL,
      whatsappDisplay: WHATSAPP_DISPLAY,
      whatsappHref: WHATSAPP_HREF,
      assetBaseUrl: getAssetBaseUrl(),
    });

    const email = org.owner?.email;
    if (email) {
      try {
        await sendEmail({
          fromEmail,
          toEmails: [email],
          subject,
          content: html,
          isHtml: true,
        });
        sent++;
        // Record dedup log
        if (trialSub) {
          const periodKey = trialEndsAt.toISOString().slice(0, 10);
          await prisma.billingEmailLog.create({
            data: {
              organizationId: org.id,
              subscriptionId: trialSub.id,
              kind: reminderKind,
              periodKey,
            },
          }).catch(() => {});
        }
      } catch (err) {
        logger.error({ err, email }, '[TrialReminderJob] send failed');
      }
    }
  }

  if (sent > 0) {
    logger.info({ sent }, '[TrialReminderJob] trial reminders sent');
  }
}

function startTrialReminderJob() {
  const schedule = process.env.TRIAL_REMINDER_CRON || '0 9 * * *';
  cron.schedule(schedule, () => {
    withCronLock('billingRenewalReminder', runTrialReminders).catch((err) => {
      logger.error({ err }, '[TrialReminderJob] lock/run error');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[TrialReminderJob] scheduled');
}

module.exports = { startTrialReminderJob, runTrialReminders };
