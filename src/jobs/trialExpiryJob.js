/**
 * Expires trial subscriptions after the trial end calendar day (fin de día Chile).
 * Runs hourly (and once on startup) to keep subscription status in sync.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { isTrialExpired } = require('../lib/trialPeriod');

async function runTrialExpiry() {
  try {
    const trials = await prisma.subscription.findMany({
      where: {
        status: 'trial',
        organization: { trialEndsAt: { not: null } },
      },
      select: {
        id: true,
        organization: { select: { trialEndsAt: true } },
      },
    });

    const ids = trials
      .filter((row) => isTrialExpired(row.organization.trialEndsAt))
      .map((row) => row.id);

    if (ids.length === 0) return;

    const expired = await prisma.subscription.updateMany({
      where: { id: { in: ids } },
      data: { status: 'expired', isActiveSubscription: false },
    });

    if (expired.count > 0) {
      logger.info({ count: expired.count }, '[TrialExpiryJob] trials expired');
    }
  } catch (err) {
    logger.error({ err }, '[TrialExpiryJob] failed');
  }
}

function startTrialExpiryJob() {
  const schedule = process.env.TRIAL_EXPIRY_CRON || '0 * * * *';
  cron.schedule(schedule, runTrialExpiry, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[TrialExpiryJob] scheduled');

  runTrialExpiry().catch((err) => {
    logger.error({ err }, '[TrialExpiryJob] startup run failed');
  });
}

module.exports = { startTrialExpiryJob, runTrialExpiry };
