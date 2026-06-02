'use strict';

/**
 * Billing integrity job — runs daily and reports anomalies via BillingOpsAlert.
 * Acts as a dead-man's switch: if it hasn't run successfully in 24h, something is wrong.
 *
 * Also checks if other critical billing jobs have run within their expected window
 * and alerts if they appear to have stopped.
 */

const cron = require('node-cron');
const logger = require('../lib/logger');
const prisma = require('../lib/prisma');
const { runBillingIntegrityChecks } = require('../services/billing/billingIntegrityService');
const { withCronLock } = require('../lib/cronLock');

// Track last successful run timestamps for dead-man's switch
const jobLastRun = {
  trialExpiry: null,
  gracePeriodExpiry: null,
  reconciliation: null,
  manualPeriodOverdue: null,
};

function recordJobRun(jobName) {
  jobLastRun[jobName] = new Date();
}

async function runIntegrityAndDeadmanCheck() {
  logger.info('[BillingIntegrity] Starting integrity check');
  const now = new Date();
  const { createOpsAlert } = require('../services/billing/billingEmailService');

  // Dead-man's switch: alert if any billing job hasn't run in 28 hours
  const ALERT_THRESHOLD_MS = 28 * 60 * 60 * 1000;
  for (const [jobName, lastRun] of Object.entries(jobLastRun)) {
    if (!lastRun || (now.getTime() - lastRun.getTime()) > ALERT_THRESHOLD_MS) {
      const msg = lastRun
        ? `Último run hace ${Math.round((now.getTime() - lastRun.getTime()) / 3600000)}h`
        : 'Nunca ha corrido en esta instancia (posible reinicio reciente)';
      logger.warn({ jobName, lastRun }, `[BillingIntegrity] Dead-man: ${jobName} no ha corrido en 28h`);
      try {
        await createOpsAlert({
          organizationId: null,
          subscriptionId: null,
          kind: `deadman_${jobName}`,
          severity: 'critical',
          title: `[Dead-man] Job de facturación detenido: ${jobName}`,
          detail: msg,
          suggestedAction: 'Verificar que el proceso del servidor está corriendo y que el job no está fallando silenciosamente.',
          dedupeKey: `deadman:${jobName}:${now.toISOString().slice(0, 13)}`,
        });
      } catch (alertErr) {
        logger.warn({ err: alertErr }, '[BillingIntegrity] Dead-man alert failed');
      }
    }
  }

  // Integrity checks
  try {
    const results = await runBillingIntegrityChecks();
    const failures = results.filter((r) => !r.ok);
    logger.info({ results }, '[BillingIntegrity] Integrity check completed');
    if (failures.length > 0) {
      logger.warn({ failures }, '[BillingIntegrity] Integrity issues detected');
    }
  } catch (err) {
    logger.error({ err }, '[BillingIntegrity] Integrity check failed');
  }
}

function startBillingIntegrityJob() {
  const schedule = process.env.BILLING_INTEGRITY_CRON || '0 3 * * *'; // Daily at 3am
  cron.schedule(schedule, () => {
    withCronLock('billingIntegrity', runIntegrityAndDeadmanCheck).catch((err) => {
      logger.error({ err }, '[BillingIntegrity] Job failed');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[BillingIntegrityJob] scheduled');
}

module.exports = {
  startBillingIntegrityJob,
  runIntegrityAndDeadmanCheck,
  recordJobRun,
};
