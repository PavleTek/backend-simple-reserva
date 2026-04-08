/**
 * Expires grace period subscriptions when gracePeriodEndsAt has passed.
 * Runs daily after payment failure grace period ends.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

async function runGracePeriodExpiry() {
  try {
    const now = new Date();
    const expired = await prisma.subscription.updateMany({
      where: {
        status: 'grace',
        gracePeriodEndsAt: { lt: now, not: null },
      },
      data: { status: 'expired' },
    });

    if (expired.count > 0) {
      logger.info({ count: expired.count }, '[GracePeriodExpiryJob] grace periods expired');
    }
  } catch (err) {
    logger.error({ err }, '[GracePeriodExpiryJob] failed');
  }
}

function startGracePeriodExpiryJob() {
  const schedule = process.env.GRACE_PERIOD_EXPIRY_CRON || '0 2 * * *';
  cron.schedule(schedule, runGracePeriodExpiry, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[GracePeriodExpiryJob] scheduled');
}

module.exports = { startGracePeriodExpiryJob, runGracePeriodExpiry };
