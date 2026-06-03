/**
 * Subscription enforcement.
 * Primary gate: isActiveSubscription === true on any Subscription row for the org.
 * Secondary gate (self-correcting): date conditions checked at runtime to catch
 * subscriptions that should have been expired by a cron job that didn't run.
 * When a stale-active sub is detected, access is denied immediately and the DB
 * is corrected asynchronously.
 */

const prisma = require('../lib/prisma');
const { isTrialExpired, isTrialActive } = require('../lib/trialPeriod');

async function getOrganizationWithTrial(organizationId) {
  return prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true, billingEmail: true },
  });
}

/**
 * Returns true if the subscription should be treated as expired based on date
 * conditions, even though isActiveSubscription is still true in the DB.
 * Covers:
 * - grace/cancelled: gracePeriodEndsAt has passed
 * - trial: org.trialEndsAt has passed (caller must supply trialEndsAt)
 * - automatic zombie: active + no preapprovalId + currentPeriodEnd in the past
 */
function isDateExpired(sub, trialEndsAt) {
  const now = new Date();

  if (
    (sub.status === 'grace' || sub.status === 'cancelled') &&
    sub.gracePeriodEndsAt &&
    new Date(sub.gracePeriodEndsAt) < now
  ) {
    return `${sub.status} grace expired (gracePeriodEndsAt=${sub.gracePeriodEndsAt.toISOString()})`;
  }

  if (sub.status === 'trial' && trialEndsAt && new Date(trialEndsAt) < now) {
    return `trial ended (trialEndsAt=${new Date(trialEndsAt).toISOString()})`;
  }

  if (
    sub.status === 'active' &&
    sub.billingStrategy === 'automatic_recurring' &&
    !sub.mercadopagoPreapprovalId &&
    sub.currentPeriodEnd &&
    new Date(sub.currentPeriodEnd) < now
  ) {
    return `automatic zombie: active with null preapproval and past currentPeriodEnd (${sub.currentPeriodEnd.toISOString()})`;
  }

  return null;
}

/**
 * Returns the active subscription for an organization, or null if none.
 * isActiveSubscription is the primary access gate; date conditions provide a
 * self-correcting secondary check so missed cron jobs don't leak access.
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
  if (!sub) return null;

  let trialEndsAt = null;
  if (sub.status === 'trial') {
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: { trialEndsAt: true },
    });
    trialEndsAt = org?.trialEndsAt ?? null;
  }

  const expireReason = isDateExpired(sub, trialEndsAt);
  if (expireReason) {
    console.warn(
      `[subscriptionService] Self-correcting stale-active sub org=${organizationId} id=${sub.id}: ${expireReason}`,
    );
    prisma.subscription
      .update({ where: { id: sub.id }, data: { isActiveSubscription: false, status: 'expired' } })
      .catch((err) => console.error('[subscriptionService] Self-correct failed:', err?.message));
    return null;
  }

  return sub;
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
