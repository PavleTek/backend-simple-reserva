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
      data: { status: 'expired', isActiveSubscription: false },
    });

    // Also deactivate cancelled subs whose gracePeriodEndsAt (= endDate) has passed.
    // These were cancelled by the user and gracePeriodEndsAt was set equal to endDate.
    const cancelledExpired = await prisma.subscription.updateMany({
      where: {
        status: 'cancelled',
        isActiveSubscription: true,
        gracePeriodEndsAt: { lt: now, not: null },
      },
      data: { status: 'expired', isActiveSubscription: false },
    });

    const total = expired.count + cancelledExpired.count;
    if (total > 0) {
      logger.info({ grace: expired.count, cancelled: cancelledExpired.count }, '[GracePeriodExpiryJob] subscriptions expired');
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
