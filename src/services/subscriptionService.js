/**
 * Subscription enforcement.
 * Access = isActiveSubscription === true on any Subscription row for the org.
 * The status field is informational only; access is never derived from it.
 */

const prisma = require('../lib/prisma');

async function getOrganizationWithTrial(organizationId) {
  return prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true },
  });
}

/**
 * Returns the active subscription for an organization, or null if none.
 * Access is determined solely by isActiveSubscription — no status or date checks.
 */
async function getActiveSubscription(organizationId) {
  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId,
      isActiveSubscription: true,
    },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });
  return sub ?? null;
}

/**
 * Check if organization has active access.
 */
async function hasActiveAccess(organizationId) {
  const sub = await getActiveSubscription(organizationId);
  return !!sub;
}

/**
 * Check if organization is in trial period (informational — for UI/emails).
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
