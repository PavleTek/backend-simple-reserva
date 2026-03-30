/**
 * Subscription enforcement - MVP: single plan, trial then paid.
 * Trial: 14 days, full access. Paid: $4,990 CLP every 2 weeks, full access.
 * Access = (in trial) OR (active paid subscription).
 */

const prisma = require('../lib/prisma');

async function getOrganizationWithTrial(organizationId) {
  return prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true },
  });
}

async function getActiveSubscription(organizationId) {
  const now = new Date();
  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId,
      status: { in: ['active', 'cancelled', 'grace'] },
      // Exclude future-dated subs (e.g., scheduled subs that got cancelled before starting)
      startDate: { lte: now },
    },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });
  if (!sub) return null;

  // Grace period: access until gracePeriodEndsAt
  if (sub.status === 'grace') {
    if (sub.gracePeriodEndsAt && now > sub.gracePeriodEndsAt) return null;
    return sub;
  }

  // Cancelled: only grants access if endDate is explicitly set and still in the future
  if (sub.status === 'cancelled') {
    if (!sub.endDate) return null;
    if (now > sub.endDate) return null;
    return sub;
  }

  // Active: grants access regardless (endDate on active subs is unusual but handled)
  if (sub.status === 'active') {
    if (sub.endDate && now > sub.endDate) return null;
    return sub;
  }

  return null;
}

/**
 * Check if organization has active access (trial or paid).
 */
async function hasActiveAccess(organizationId) {
  const organization = await getOrganizationWithTrial(organizationId);
  if (!organization) return false;

  // In trial: trialEndsAt is set and in the future
  if (organization.trialEndsAt && new Date() < organization.trialEndsAt) {
    return true;
  }

  // Paid: active subscription
  const sub = await getActiveSubscription(organizationId);
  return !!sub;
}

/**
 * Check if organization is in trial period.
 */
async function isTrialing(organizationId) {
  const organization = await getOrganizationWithTrial(organizationId);
  if (!organization || !organization.trialEndsAt) return false;
  return new Date() < organization.trialEndsAt;
}

/**
 * Check if restaurant can create a new reservation.
 * @returns {{ allowed: boolean, reason?: string }}
 */
async function canCreateReservation(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { organizationId: true },
  });
  if (!restaurant) return { allowed: false, reason: 'Restaurante no encontrado' };

  const hasAccess = await hasActiveAccess(restaurant.organizationId);
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
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { organizationId: true },
  });
  if (!restaurant) return false;
  return hasActiveAccess(restaurant.organizationId);
}

/**
 * Check if restaurant can send reminders.
 */
async function canSendReminders(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { organizationId: true },
  });
  if (!restaurant) return false;
  return hasActiveAccess(restaurant.organizationId);
}

module.exports = {
  getActiveSubscription,
  getOrganizationWithTrial,
  hasActiveAccess,
  isTrialing,
  canCreateReservation,
  canSendConfirmations,
  canSendReminders,
};
