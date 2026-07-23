'use strict';

/**
 * Distributed cron guard using a PostgreSQL advisory lock.
 *
 * Only one server instance should run the billing cron jobs at a time.
 * When CRON_SINGLE_RUNNER=true (default in production), every job run
 * attempts to acquire a cluster-wide advisory lock.  If the lock is
 * already held by another instance, the job skips its run gracefully.
 *
 * Set CRON_SINGLE_RUNNER=false (or omit) in development/testing to let
 * all instances run their jobs normally.
 *
 * Usage:
 *   const { withCronLock } = require('../lib/cronLock');
 *
 *   cron.schedule(CRON, () => {
 *     withCronLock('trialExpiry', runTrialExpiry).catch(logger.error);
 *   });
 */

const prisma = require('./prisma');
const logger = require('./logger');

// Deterministic lock keys per job (arbitrary unique integers > 0)
const JOB_LOCK_KEYS = {
  trialExpiry:          1_100_001,
  gracePeriodExpiry:    1_100_002,
  reconciliation:       1_100_003,
  manualPeriodOverdue:  1_100_004,
  planChangeScheduler:  1_100_005,
  billingRenewalReminder: 1_100_006,
  lastChanceLink:       1_100_007,
  referralEvaluation:   1_100_008,
  billingIntegrity:     1_100_009,
  reservationImport:    1_100_010,
  insights:             1_100_011,
};

function isSingleRunnerEnabled() {
  return process.env.CRON_SINGLE_RUNNER === 'true';
}

/**
 * Wraps a cron job function with a PostgreSQL session advisory lock.
 * If the lock is held by another instance, the run is skipped.
 *
 * @param {string} jobName  Key from JOB_LOCK_KEYS
 * @param {Function} fn     Async job function
 */
async function withCronLock(jobName, fn) {
  if (!isSingleRunnerEnabled()) {
    return fn();
  }

  const lockKey = JOB_LOCK_KEYS[jobName];
  if (!lockKey) {
    logger.warn({ jobName }, '[cronLock] Unknown job name — running without lock');
    return fn();
  }

  let acquired = false;
  try {
    const result = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${lockKey}::bigint) AS ok`;
    acquired = result?.[0]?.ok === true;
  } catch (err) {
    logger.warn({ err, jobName }, '[cronLock] Advisory lock check failed — running without lock');
    return fn();
  }

  if (!acquired) {
    logger.info({ jobName }, '[cronLock] Lock held by another instance — skipping run');
    return;
  }

  try {
    return await fn();
  } finally {
    try {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
    } catch (err) {
      logger.warn({ err, jobName }, '[cronLock] Failed to release advisory lock');
    }
  }
}

module.exports = { withCronLock, JOB_LOCK_KEYS };
