'use strict';

/**
 * reservationHoldCleanup.js
 *
 * Job de mantenimiento del sistema de holds.
 *
 * Cada 60 s: marca como 'expired' los holds activos con expiresAt < NOW().
 *   La lógica de availability ya los ignora (filtra por expiresAt > now),
 *   pero este job mantiene el campo status consistente.
 *
 * Cada 24 h: elimina registros consumidos/liberados/expirados con más de 7 días.
 */

const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

const EXPIRE_INTERVAL_MS = 60 * 1000;       // 60 segundos
const PURGE_INTERVAL_MS  = 24 * 60 * 60 * 1000; // 24 horas

async function expireHolds() {
  try {
    const now = new Date();
    const { count } = await prisma.reservationHold.updateMany({
      where: { status: 'active', expiresAt: { lt: now } },
      data: { status: 'expired' },
    });
    if (count > 0) {
      logger.info({ count }, 'reservationHoldCleanup: holds marcados como expirados');
    }
  } catch (err) {
    logger.error({ err }, 'reservationHoldCleanup: error al expirar holds');
  }
}

async function purgeOldHolds() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { count } = await prisma.reservationHold.deleteMany({
      where: {
        status: { in: ['expired', 'released', 'consumed'] },
        createdAt: { lt: cutoff },
      },
    });
    if (count > 0) {
      logger.info({ count }, 'reservationHoldCleanup: holds antiguos eliminados');
    }
  } catch (err) {
    logger.error({ err }, 'reservationHoldCleanup: error al purgar holds');
  }
}

function startReservationHoldCleanupJob() {
  const expireTimer = setInterval(expireHolds, EXPIRE_INTERVAL_MS);
  const purgeTimer  = setInterval(purgeOldHolds, PURGE_INTERVAL_MS);

  // Evitar que los timers mantengan el proceso vivo
  expireTimer.unref?.();
  purgeTimer.unref?.();

  // Ejecutar inmediatamente al iniciar
  expireHolds();

  logger.info('reservationHoldCleanup: job iniciado (expire cada 60s, purge cada 24h)');

  return { expireTimer, purgeTimer };
}

module.exports = { startReservationHoldCleanupJob };
