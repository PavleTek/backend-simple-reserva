'use strict';

/**
 * PostgreSQL advisory locks for per-org billing mutations.
 *
 * Uses pg_try_advisory_xact_lock(key) which:
 * - Is scoped to the current transaction
 * - Is automatically released when the transaction ends
 * - Returns false (non-blocking) if the lock is already held
 *
 * For operations outside a transaction, pg_try_advisory_lock / pg_advisory_unlock are used.
 * We generate a deterministic integer key from the organizationId using a simple hash.
 *
 * Usage:
 *   const { withOrgBillingLock } = require('../lib/advisoryLock');
 *   await withOrgBillingLock(prisma, organizationId, async () => { ... });
 */

const prisma = require('./prisma');

const LOCK_NAMESPACE = 1234567890; // arbitrary namespace for billing locks

/**
 * Deterministic int32 hash of a string (djb2). Used to map orgId → lock key.
 * Collision probability is low for typical org count; log the key if debugging.
 */
function orgIdToLockKey(organizationId) {
  let hash = 5381;
  for (let i = 0; i < organizationId.length; i++) {
    hash = (((hash << 5) + hash) + organizationId.charCodeAt(i)) & 0x7fffffff;
  }
  // Combine with namespace to reduce cross-domain collisions
  return ((LOCK_NAMESPACE ^ hash) & 0x7fffffff);
}

/**
 * Executes fn under a per-org session-level advisory lock.
 * Throws if the lock cannot be acquired within the timeout (another request is running).
 *
 * @param {string} organizationId
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number, client?: object }} [opts]
 * @returns {Promise<T>}
 */
async function withOrgBillingLock(organizationId, fn, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  const lockKey = orgIdToLockKey(organizationId);

  // Use a raw client via $queryRawUnsafe for non-transactional advisory lock
  const acquired = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${lockKey}::bigint) AS ok`;
  if (!acquired?.[0]?.ok) {
    const err = new Error(
      'Hay otra operación de facturación en curso para tu cuenta. Espera un momento e inténtalo de nuevo.',
    );
    err.statusCode = 409;
    err.code = 'billing_lock_conflict';
    throw err;
  }

  // Set a timeout on the lock to auto-release if we crash or hang
  const lockTimeout = setTimeout(async () => {
    try {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
    } catch {
      // Ignore — session ends anyway
    }
  }, timeoutMs + 5000);

  try {
    return await fn();
  } finally {
    clearTimeout(lockTimeout);
    try {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
    } catch (unlockErr) {
      console.warn('[advisoryLock] Failed to release lock for org:', organizationId, unlockErr?.message);
    }
  }
}

module.exports = { withOrgBillingLock, orgIdToLockKey };
