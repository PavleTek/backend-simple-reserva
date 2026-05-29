/**
 * Subscription enforcement.
 * Access = isActiveSubscription === true on any Subscription row for the org.
 * The status field is informational only; access is never derived from it.
 */

const prisma = require('../lib/prisma');
const { isTrialExpired, isTrialActive } = require('../lib/trialPeriod');

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
 * Trial con trialEndsAt vencido no cuenta como acceso aunque isActiveSubscription siga true hasta el job.
 */
async function hasActiveAccess(organizationId) {
  const sub = await getActiveSubscription(organizationId);
  if (!sub) return false;
  if (sub.status === 'trial') {
    const organization = await getOrganizationWithTrial(organizationId);
    if (organization?.trialEndsAt && isTrialExpired(organization.trialEndsAt)) {
      return false;
    }
  }
  return true;
}

/**
 * Check if organization is in trial period (informational — for UI/emails).
 */
async function isTrialing(organizationId) {
  const organization = await getOrganizationWithTrial(organizationId);
  if (!organization?.trialEndsAt) return false;
  return isTrialActive(organization.trialEndsAt);
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

/**
 * Check if restaurant can send post-visit feedback emails.
 */
async function canSendFeedback(restaurantId) {
  if (process.env.FEEDBACK_ENABLED_GLOBAL === 'false') return false;
  return canSendReminders(restaurantId);
}

module.exports = {
  getActiveSubscription,
  getOrganizationWithTrial,
  hasActiveAccess,
  isTrialing,
  canCreateReservation,
  canSendConfirmations,
  canSendReminders,
  canSendFeedback,
};
