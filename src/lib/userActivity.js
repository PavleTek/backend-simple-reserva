'use strict';

/** Throttle: máximo un write por usuario cada 30 min (portal restaurante o admin). */
const USER_ACTIVITY_TOUCH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Actualiza User.lastLogin si pasó el intervalo de throttle.
 * Reutilizamos lastLogin como "última actividad" (login o uso autenticado del producto).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @returns {Promise<{ updated: boolean, lastLogin: Date | null }>}
 */
async function touchUserActivity(prisma, userId) {
  const threshold = new Date(Date.now() - USER_ACTIVITY_TOUCH_INTERVAL_MS);
  const now = new Date();

  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ lastLogin: null }, { lastLogin: { lt: threshold } }],
    },
    data: { lastLogin: now },
  });

  if (result.count > 0) {
    return { updated: true, lastLogin: now };
  }

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastLogin: true },
  });

  return { updated: false, lastLogin: row?.lastLogin ?? null };
}

module.exports = { USER_ACTIVITY_TOUCH_INTERVAL_MS, touchUserActivity };
