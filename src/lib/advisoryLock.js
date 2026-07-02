'use strict';

/**
 * PostgreSQL advisory locks for per-org billing mutations.
 *
 * Uses pg_try_advisory_xact_lock(key) which:
 * - Is scoped to the current transaction
 * - Is automatically released when the transaction ends
 * - Returns false (non-blocking) if the lock is already held
 *
 * We generate a deterministic integer key from the organizationId using a simple hash.
 *
 * Usage:
 *   const { withOrgBillingLock } = require('../lib/advisoryLock');
 *   await withOrgBillingLock(organizationId, async () => { ... });
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
 * Executes fn under a per-org advisory lock.
 * Throws if the lock cannot be acquired (another request is running).
 *
 * IMPORTANTE: usa pg_try_advisory_xact_lock (transaction-scoped), NO
 * pg_try_advisory_lock/pg_advisory_unlock (session-scoped). Con el pool de
 * conexiones de Prisma, dos $queryRaw sueltos (lock y unlock) pueden ejecutarse
 * en conexiones físicas distintas del pool: el unlock "libera" en la conexión
 * equivocada y el lock queda pegado para siempre en la conexión original hasta
 * que esa conexión se cierre (podía tardar horas). Eso causaba que un org
 * quedara bloqueado indefinidamente para pagar tras un solo intento.
 * pg_try_advisory_xact_lock se libera solo al terminar la transacción
 * (commit o rollback), que Prisma garantiza que corre en una única conexión.
 *
 * @param {string} organizationId
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number }} [opts] Tiempo máximo que puede durar fn() (incluye llamadas a MP).
 * @returns {Promise<T>}
 */
async function withOrgBillingLock(organizationId, fn, opts = {}) {
  const { timeoutMs = 25000 } = opts;
  const lockKey = orgIdToLockKey(organizationId);

  return prisma.$transaction(
    async (tx) => {
      const acquired = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS ok`;
      if (!acquired?.[0]?.ok) {
        const err = new Error(
          'Hay otra operación de facturación en curso para tu cuenta. Espera un momento e inténtalo de nuevo.',
        );
        err.statusCode = 409;
        err.code = 'billing_lock_conflict';
        throw err;
      }
      return fn();
    },
    { timeout: timeoutMs, maxWait: 10000 },
  );
}

module.exports = { withOrgBillingLock, orgIdToLockKey };
