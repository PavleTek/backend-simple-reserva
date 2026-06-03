'use strict';

/**
 * Billing integrity checks — run as a scheduled job or on-demand from admin.
 *
 * Each check returns { name, count, rows?, severity } and creates a BillingOpsAlert
 * for any count > 0.
 *
 * Detects:
 *  1. Multi-active subs per org (violates partial unique index — should never happen)
 *  2. Automatic zombie: active + null preapproval + past currentPeriodEnd
 *  3. Grace/cancelled past gracePeriodEndsAt still active (cron missed)
 *  4. Trial past trialEndsAt still active (cron missed)
 *  5. Available ReferralCredit past expiresAt (expiry job missed)
 *  6. WebhookEvents stuck in processing/received for > 30 minutes
 */

const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');

const CHECKS = [
  {
    name: 'multi_active_subs_per_org',
    severity: 'critical',
    title: 'Múltiples suscripciones activas por organización',
    async run() {
      const rows = await prisma.$queryRaw`
        SELECT "organizationId", COUNT(*) as cnt
        FROM "Subscription"
        WHERE "isActiveSubscription" = true
        GROUP BY "organizationId"
        HAVING COUNT(*) > 1
      `;
      return { count: rows.length, rows };
    },
  },
  {
    name: 'automatic_zombie_active',
    severity: 'critical',
    title: 'Suscripciones automáticas zombie (activas sin preapproval y con periodo vencido)',
    async run() {
      const now = new Date();
      const rows = await prisma.subscription.findMany({
        where: {
          status: 'active',
          isActiveSubscription: true,
          billingStrategy: 'automatic_recurring',
          mercadopagoPreapprovalId: null,
          currentPeriodEnd: { lt: now },
        },
        select: { id: true, organizationId: true, currentPeriodEnd: true, startDate: true },
      });
      return { count: rows.length, rows };
    },
  },
  {
    name: 'grace_past_period_still_active',
    severity: 'warning',
    title: 'Suscripciones en grace/cancelled con gracePeriodEndsAt vencido pero aún activas',
    async run() {
      const now = new Date();
      const rows = await prisma.subscription.findMany({
        where: {
          status: { in: ['grace', 'cancelled'] },
          isActiveSubscription: true,
          gracePeriodEndsAt: { lt: now, not: null },
        },
        select: { id: true, organizationId: true, status: true, gracePeriodEndsAt: true },
      });
      return { count: rows.length, rows };
    },
  },
  {
    name: 'trial_past_end_still_active',
    severity: 'warning',
    title: 'Suscripciones en trial con trialEndsAt vencido pero aún activas',
    async run() {
      const now = new Date();
      const rows = await prisma.subscription.findMany({
        where: {
          status: 'trial',
          isActiveSubscription: true,
          organization: { trialEndsAt: { lt: now, not: null } },
        },
        select: { id: true, organizationId: true, startDate: true },
      });
      return { count: rows.length, rows };
    },
  },
  {
    name: 'referral_credit_available_past_expiry',
    severity: 'info',
    title: 'ReferralCredit disponibles con expiresAt vencido (job de expiración no corrió)',
    async run() {
      const rows = await prisma.referralCredit.findMany({
        where: {
          status: 'available',
          expiresAt: { lt: new Date() },
        },
        select: { id: true, organizationId: true, expiresAt: true, amountDays: true },
      });
      return { count: rows.length, rows };
    },
  },
  {
    name: 'webhook_events_stuck',
    severity: 'warning',
    title: 'WebhookEvents atascados en estado processing/received por más de 30 min',
    async run() {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const rows = await prisma.webhookEvent.findMany({
        where: {
          processingStatus: { in: ['processing', 'received'] },
          createdAt: { lt: cutoff },
        },
        select: { id: true, mpEventType: true, mpDataId: true, processingStatus: true, createdAt: true },
      });
      return { count: rows.length, rows };
    },
  },
];

/**
 * Run all integrity checks and create ops alerts for any failures.
 * Returns a summary of check results.
 */
async function runBillingIntegrityChecks() {
  const results = [];

  for (const check of CHECKS) {
    try {
      const { count, rows } = await check.run();
      results.push({ name: check.name, count, severity: check.severity, ok: count === 0 });

      if (count > 0) {
        logger.warn(
          { check: check.name, count, severity: check.severity },
          `[BillingIntegrity] ${check.title}: ${count} registro(s)`,
        );
        try {
          const { createOpsAlert } = require('./billingEmailService');
          await createOpsAlert({
            organizationId: null,
            subscriptionId: null,
            kind: `integrity_${check.name}`,
            severity: check.severity,
            title: `[Integridad] ${check.title}`,
            detail: `${count} registro(s) afectado(s). Revisar y corregir manualmente.`,
            suggestedAction: 'Ejecutar corrección desde admin o esperar que el job de limpieza corra.',
            dedupeKey: `integrity:${check.name}:${new Date().toISOString().slice(0, 13)}`,
          });
        } catch (alertErr) {
          logger.warn({ err: alertErr }, '[BillingIntegrity] No se pudo crear ops alert');
        }
      }
    } catch (err) {
      logger.error({ err, check: check.name }, '[BillingIntegrity] Check falló');
      results.push({ name: check.name, count: -1, severity: check.severity, ok: false, error: err?.message });
    }
  }

  return results;
}

module.exports = { runBillingIntegrityChecks, CHECKS };
