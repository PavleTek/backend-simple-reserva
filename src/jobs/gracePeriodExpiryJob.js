/**
 * Expires grace period subscriptions when gracePeriodEndsAt has passed.
 * Runs daily after payment failure grace period ends.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { recordJobRun } = require('./billingIntegrityJob');
const { withCronLock } = require('../lib/cronLock');

async function runGracePeriodExpiry() {
  try {
    const now = new Date();
    const { heldOrganizationIds, excludeHeldOrganizations } = require('../services/billing/paymentRegularizationService');
    const heldIds = await heldOrganizationIds();
    const expired = await prisma.subscription.updateMany({
      where: excludeHeldOrganizations({
        status: 'grace',
        gracePeriodEndsAt: { lt: now, not: null },
      }, heldIds),
      data: { status: 'expired', isActiveSubscription: false },
    });

    // Also deactivate cancelled subs whose gracePeriodEndsAt (= endDate) has passed.
    // These were cancelled by the user and gracePeriodEndsAt was set equal to endDate.
    // Un aviso con accessUntil futuro conserva el acceso. Sin fecha, o ya vencida, no.
    const cancelledExpired = await prisma.subscription.updateMany({
      where: excludeHeldOrganizations({
        status: 'cancelled',
        isActiveSubscription: true,
        gracePeriodEndsAt: { lt: now, not: null },
      }, heldIds),
      data: { status: 'expired', isActiveSubscription: false },
    });

    // Activa, débito automático, sin id de MP ni de Flow, periodo vencido.
    // El reconciliador no las mira. El aviso las protege solo hasta accessUntil.
    const unbilledExpired = await prisma.subscription.updateMany({
      where: excludeHeldOrganizations({
        status: 'active',
        isActiveSubscription: true,
        billingStrategy: 'automatic_recurring',
        mercadopagoPreapprovalId: null,
        flowSubscriptionId: null,
        currentPeriodEnd: { lt: now },
      }, heldIds),
      data: { status: 'expired', isActiveSubscription: false },
    });

    const total = expired.count + cancelledExpired.count + unbilledExpired.count;
    if (total > 0) {
      logger.info(
        { grace: expired.count, cancelled: cancelledExpired.count, unbilled: unbilledExpired.count },
        '[GracePeriodExpiryJob] subscriptions expired',
      );
    }
    recordJobRun('gracePeriodExpiry');
  } catch (err) {
    logger.error({ err }, '[GracePeriodExpiryJob] failed');
  }
}

function startGracePeriodExpiryJob() {
  const schedule = process.env.GRACE_PERIOD_EXPIRY_CRON || '0 2 * * *';
  cron.schedule(schedule, () => {
    withCronLock('gracePeriodExpiry', runGracePeriodExpiry).catch((err) => {
      logger.error({ err }, '[GracePeriodExpiryJob] lock/run error');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[GracePeriodExpiryJob] scheduled');
}

module.exports = { startGracePeriodExpiryJob, runGracePeriodExpiry };
