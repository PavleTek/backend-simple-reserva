/**
 * Respaldo si el webhook no ejecutó finalizeEndOfPeriodPlanChangeFromSession tras autorizar un cambio diferido.
 * Cada 4 horas (minuto 15).
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { finalizeEndOfPeriodPlanChangeFromSession } = require('../services/mercadopagoService');

async function runScheduledPlanChangeGuard() {
  const sessions = await prisma.checkoutSession.findMany({
    where: {
      status: 'pending',
      pendingEndOfPeriodFromSubscriptionId: { not: null },
      mercadopagoPreapprovalId: { not: null },
      createdAt: { lt: new Date(Date.now() - 20 * 60 * 1000) },
    },
    take: 80,
  });

  for (const s of sessions) {
    try {
      await finalizeEndOfPeriodPlanChangeFromSession(s.organizationId, s.mercadopagoPreapprovalId);
    } catch (err) {
      logger.warn({ err: err?.message, sessionId: s.id }, '[scheduledPlanChangeGuard] finalize skipped');
    }
  }
}

function startScheduledPlanChangeGuardJob() {
  const schedule = process.env.SCHEDULED_PLAN_GUARD_CRON || '15 */4 * * *';
  cron.schedule(
    schedule,
    () => {
      runScheduledPlanChangeGuard().catch((err) => logger.error({ err }, '[scheduledPlanChangeGuard] job failed'));
    },
    { timezone: process.env.TZ || 'America/Santiago' },
  );
  logger.info({ schedule }, '[scheduledPlanChangeGuardJob] scheduled');
}

module.exports = { startScheduledPlanChangeGuardJob, runScheduledPlanChangeGuard };
