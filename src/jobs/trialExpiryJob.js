/**
 * Expires trial subscriptions after the trial end calendar day (fin de día Chile).
 * Runs hourly (and once on startup) to keep subscription status in sync.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { recordJobRun } = require('./billingIntegrityJob');
const { withCronLock } = require('../lib/cronLock');

async function runTrialExpiry() {
  try {
    const now = new Date();

    // Primary: expire trials where the org's trialEndsAt has passed
    const expired = await prisma.subscription.updateMany({
      where: {
        status: 'trial',
        organization: {
          trialEndsAt: { lt: now, not: null },
        },
      },
      data: { status: 'expired', isActiveSubscription: false },
    });

    // Backstop: expire trials that are very old (> 90 days from startDate) regardless
    // of trialEndsAt. This catches "immortal trials" created for zero-trial plans or
    // with null trialEndsAt that were never expired by the primary query.
    const MAX_TRIAL_DAYS = Number(process.env.MAX_TRIAL_AGE_DAYS) || 90;
    const backdropCutoff = new Date(now.getTime() - MAX_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const backstop = await prisma.subscription.updateMany({
      where: {
        status: 'trial',
        startDate: { lt: backdropCutoff },
      },
      data: { status: 'expired', isActiveSubscription: false },
    });

    const total = expired.count + backstop.count;
    if (total > 0) {
      logger.info({ primary: expired.count, backstop: backstop.count }, '[TrialExpiryJob] trials expired');
    }
    if (backstop.count > 0) {
      logger.warn({ count: backstop.count }, '[TrialExpiryJob] immortal trials expired via backstop — check trialEndsAt population');
    }
    recordJobRun('trialExpiry');
  } catch (err) {
    logger.error({ err }, '[TrialExpiryJob] failed');
  }
}

function startTrialExpiryJob() {
  const schedule = process.env.TRIAL_EXPIRY_CRON || '0 1 * * *';
  cron.schedule(schedule, () => {
    withCronLock('trialExpiry', runTrialExpiry).catch((err) => {
      logger.error({ err }, '[TrialExpiryJob] lock/run error');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[TrialExpiryJob] scheduled');

  runTrialExpiry().catch((err) => {
    logger.error({ err }, '[TrialExpiryJob] startup run failed');
  });
}

module.exports = { startTrialExpiryJob, runTrialExpiry };
