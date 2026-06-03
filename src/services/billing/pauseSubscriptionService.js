'use strict';

const prisma = require('../../lib/prisma');

const PAUSE_ENABLED = process.env.BILLING_PAUSE_ENABLED === 'true';

/**
 * Pausa suscripción hasta pauseEndsAt (no cancela en MP; informativo + flag).
 */
async function pauseSubscription(organizationId, pauseDays = 30) {
  if (!PAUSE_ENABLED) {
    const err = new Error('La pausa de suscripción no está habilitada.');
    err.statusCode = 403;
    throw err;
  }

  const sub = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true, status: 'active' },
    orderBy: { startDate: 'desc' },
  });
  if (!sub) {
    const err = new Error('No hay suscripción activa para pausar.');
    err.statusCode = 400;
    throw err;
  }

  const pauseEndsAt = new Date();
  pauseEndsAt.setDate(pauseEndsAt.getDate() + pauseDays);

  return prisma.subscription.update({
    where: { id: sub.id },
    data: {
      isPaused: true,
      pausedAt: new Date(),
      pauseEndsAt,
    },
  });
}

async function resumePausedSubscription(organizationId) {
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, isPaused: true },
    orderBy: { startDate: 'desc' },
  });
  if (!sub) return null;

  return prisma.subscription.update({
    where: { id: sub.id },
    data: {
      isPaused: false,
      pausedAt: null,
      pauseEndsAt: null,
    },
  });
}

module.exports = {
  PAUSE_ENABLED,
  pauseSubscription,
  resumePausedSubscription,
};
