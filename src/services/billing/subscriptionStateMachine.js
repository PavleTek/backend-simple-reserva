'use strict';

/**
 * Transiciones válidas de estado informativo de suscripción.
 * Los efectos secundarios reales se ejecutan vía billingStateService.applyBillingEvent.
 */

const TRANSITIONS = {
  trial: {
    CHECKOUT_APPROVED: 'active',
    TRIAL_EXPIRED: 'expired',
  },
  active: {
    PAYMENT_FAILED: 'grace',
    CANCEL_REQUESTED: 'cancelled',
    PLAN_CHANGE_SCHEDULED: 'scheduled',
  },
  grace: {
    PAYMENT_APPROVED: 'active',
    PAYMENT_RECOVERED: 'active',
    GRACE_EXPIRED: 'expired',
  },
  cancelled: {
    PERIOD_ENDED: 'expired',
    REACTIVATED: 'active',
  },
  cancelled_by_admin: {
    ADMIN_REVOKED: 'expired',
  },
  scheduled: {
    ACTIVATED: 'active',
    CANCELLED: 'cancelled',
  },
  expired: {
    CHECKOUT_APPROVED: 'active',
  },
};

class InvalidTransitionError extends Error {
  constructor(from, event, to) {
    super(`Transición inválida: ${from} + ${event} → ${to ?? '?'}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * @param {string} currentStatus
 * @param {string} event
 * @param {{ logOnly?: boolean }} [opts]
 */
function transition(currentStatus, event, opts = {}) {
  const map = TRANSITIONS[currentStatus];
  const next = map?.[event];
  if (!next) {
    if (opts.logOnly) {
      return { newStatus: currentStatus, sideEffects: [] };
    }
    throw new InvalidTransitionError(currentStatus, event);
  }

  const sideEffects = [];
  if (event === 'PAYMENT_FAILED') {
    sideEffects.push('set_grace_period_7d', 'send_payment_failed_email');
  }
  if (event === 'PAYMENT_APPROVED' || event === 'PAYMENT_RECOVERED') {
    if (currentStatus === 'grace') {
      sideEffects.push('clear_grace', 'send_payment_recovered_email');
    }
  }
  if (event === 'CHECKOUT_APPROVED') {
    sideEffects.push('activate_subscription', 'send_payment_approved_email');
  }
  if (event === 'CANCEL_REQUESTED') {
    sideEffects.push('cancel_at_period_end', 'send_subscription_cancelled_email');
  }
  if (event === 'PLAN_CHANGE_SCHEDULED') {
    sideEffects.push('send_plan_change_scheduled_email');
  }
  if (event === 'ACTIVATED' && currentStatus === 'scheduled') {
    sideEffects.push('send_plan_change_applied_email');
  }

  return { newStatus: next, sideEffects };
}

module.exports = {
  TRANSITIONS,
  transition,
  InvalidTransitionError,
};
