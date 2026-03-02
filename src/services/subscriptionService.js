/**
 * Subscription enforcement - MVP: single plan, trial then paid.
 * Trial: 14 days, full access. Paid: $4,990 CLP every 2 weeks, full access.
 * Access = (in trial) OR (active paid subscription).
 */

const prisma = require('../lib/prisma');

async function getRestaurantWithTrial(restaurantId) {
  return prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { trialEndsAt: true },
  });
}

async function getActiveSubscription(restaurantId) {
  const sub = await prisma.subscription.findFirst({
    where: {
      restaurantId,
      status: { in: ['active', 'cancelled'] },
    },
    orderBy: { startDate: 'desc' },
  });
  if (!sub) return null;
  if (sub.endDate && new Date() > sub.endDate) return null;
  if (sub.status === 'cancelled' && (!sub.endDate || new Date() <= sub.endDate)) return sub;
  if (sub.status === 'active') return sub;
  return null;
}

/**
 * Check if restaurant has active access (trial or paid).
 */
async function hasActiveAccess(restaurantId) {
  const restaurant = await getRestaurantWithTrial(restaurantId);
  if (!restaurant) return false;

  // In trial: trialEndsAt is set and in the future
  if (restaurant.trialEndsAt && new Date() < restaurant.trialEndsAt) {
    return true;
  }

  // Paid: active subscription
  const sub = await getActiveSubscription(restaurantId);
  return !!sub;
}

/**
 * Check if restaurant is in trial period.
 */
async function isTrialing(restaurantId) {
  const restaurant = await getRestaurantWithTrial(restaurantId);
  if (!restaurant || !restaurant.trialEndsAt) return false;
  return new Date() < restaurant.trialEndsAt;
}

/**
 * Check if restaurant can create a new reservation.
 * @returns {{ allowed: boolean, reason?: string }}
 */
async function canCreateReservation(restaurantId) {
  const hasAccess = await hasActiveAccess(restaurantId);
  if (!hasAccess) {
    return {
      allowed: false,
      reason: 'Tu periodo de prueba ha terminado. Activa tu suscripcion para seguir recibiendo reservas.',
    };
  }
  return { allowed: true };
}

/**
 * Check if restaurant can send SMS confirmations.
 */
async function canSendConfirmations(restaurantId) {
  return hasActiveAccess(restaurantId);
}

/**
 * Check if restaurant can send reminders.
 */
async function canSendReminders(restaurantId) {
  return hasActiveAccess(restaurantId);
}

module.exports = {
  getActiveSubscription,
  getRestaurantWithTrial,
  hasActiveAccess,
  isTrialing,
  canCreateReservation,
  canSendConfirmations,
  canSendReminders,
};
