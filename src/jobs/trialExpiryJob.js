/**
 * Expires trial subscriptions when trialEndsAt has passed.
 * Runs daily to keep subscription status in sync with trial dates.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');

async function runTrialExpiry() {
  const now = new Date();
  const expired = await prisma.subscription.updateMany({
    where: {
      status: 'trial',
      restaurant: {
        trialEndsAt: { lt: now, not: null },
      },
    },
    data: { status: 'expired' },
  });

  if (expired.count > 0) {
    console.log(`[TrialExpiryJob] Expired ${expired.count} trial subscription(s)`);
  }
}

function startTrialExpiryJob() {
  const schedule = process.env.TRIAL_EXPIRY_CRON || '0 1 * * *';
  cron.schedule(schedule, runTrialExpiry, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log(`[TrialExpiryJob] Scheduled: ${schedule}`);
}

module.exports = { startTrialExpiryJob, runTrialExpiry };
