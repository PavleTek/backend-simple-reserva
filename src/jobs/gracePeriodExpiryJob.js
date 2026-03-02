/**
 * Expires grace period subscriptions when gracePeriodEndsAt has passed.
 * Runs daily after payment failure grace period ends.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');

async function runGracePeriodExpiry() {
  const now = new Date();
  const expired = await prisma.subscription.updateMany({
    where: {
      status: 'grace',
      gracePeriodEndsAt: { lt: now, not: null },
    },
    data: { status: 'expired' },
  });

  if (expired.count > 0) {
    console.log(`[GracePeriodExpiryJob] Expired ${expired.count} grace period subscription(s)`);
  }
}

function startGracePeriodExpiryJob() {
  const schedule = process.env.GRACE_PERIOD_EXPIRY_CRON || '0 2 * * *';
  cron.schedule(schedule, runGracePeriodExpiry, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log(`[GracePeriodExpiryJob] Scheduled: ${schedule}`);
}

module.exports = { startGracePeriodExpiryJob, runGracePeriodExpiry };
