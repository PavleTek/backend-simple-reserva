/**
 * Expires trial subscriptions when trialEndsAt has passed.
 * Runs daily to keep subscription status in sync with trial dates.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

async function runTrialExpiry() {
  try {
    const now = new Date();
    const expired = await prisma.subscription.updateMany({
      where: {
        status: 'trial',
        organization: {
          trialEndsAt: { lt: now, not: null },
        },
      },
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
  const schedule = process.env.TRIAL_EXPIRY_CRON || '0 1 * * *';
  cron.schedule(schedule, runTrialExpiry, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[TrialExpiryJob] scheduled');
}

module.exports = { startTrialExpiryJob, runTrialExpiry };
