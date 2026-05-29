'use strict';

const { resolvePlanChangeType } = require('../../lib/planDisplayOrder');
const referralService = require('../referralService');
const {
  isInReferralFreeWindow,
  isReferralCreditExtensionScheduled,
} = require('./referralFreeWindowService');

/**
 * Periodo con crédito de referido aplicado (ventana activa o extensión programada tras opt-in).
 * Durante este periodo no se permite cambio de plan.
 */
function isReferralCreditPeriodLocked(sub, now = new Date()) {
  if (!sub?.referralFreeUntil) return false;
  if (new Date(sub.referralFreeUntil) <= now) return false;
  return isInReferralFreeWindow(sub, now) || isReferralCreditExtensionScheduled(sub, now);
}

/**
 * Fecha en que debe diferirse el primer cobro MP (ventana activa o extensión programada).
 */
function deferredChargeDateForReferralCredits(sub, now = new Date()) {
  if (!sub?.referralFreeUntil) return null;
  const freeUntil = new Date(sub.referralFreeUntil);
  if (freeUntil <= now) return null;
  if (isInReferralFreeWindow(sub, now) || isReferralCreditExtensionScheduled(sub, now)) {
    return freeUntil;
  }
  return null;
}

/**
 * @param {object} params
 * @param {object|null} params.sub
 * @param {string} params.currentSku
 * @param {string} params.newSku
 * @param {number} params.creditsAvailableDays
 * @param {boolean} [params.confirmForfeitReferralCredits]
 */
function evaluatePlanChangeReferralPolicy({
  sub,
  currentSku,
  newSku,
  creditsAvailableDays,
  confirmForfeitReferralCredits = false,
}) {
  if (isReferralCreditPeriodLocked(sub)) {
    const until = sub.referralFreeUntil?.toISOString?.() ?? null;
    return {
      allowed: false,
      code: 'referral_period_locked',
      error:
        'No puedes cambiar de plan mientras tengas días gratis de referido activos o programados en tu renovación. Espera a que termine ese periodo o contacta a soporte.',
      referralFreeUntil: until,
      planChangeBlocked: true,
    };
  }

  if (creditsAvailableDays <= 0) {
    return { allowed: true, planChangeBlocked: false };
  }

  const tierChange = resolvePlanChangeType(currentSku, newSku);
  if (tierChange === 'upgrade' || tierChange === 'downgrade') {
    return {
      allowed: false,
      code: 'referral_credits_cross_tier',
      error:
        'No puedes subir ni bajar de tier mientras tengas créditos de referido disponibles. Canjéalos en tu renovación o elige un plan del mismo tier.',
      creditsAvailableDays,
      planChangeBlocked: false,
      sameTierOnly: true,
    };
  }

  if (!confirmForfeitReferralCredits) {
    return {
      allowed: false,
      code: 'referral_credits_forfeit_required',
      error:
        'Al cambiar de plan perderás tus créditos de referido disponibles. Solo puedes cambiar dentro del mismo tier.',
      requiresForfeitConfirmation: true,
      creditsAvailableDays,
      planChangeBlocked: false,
    };
  }

  return {
    allowed: true,
    forfeitAvailableCredits: true,
    creditsAvailableDays,
    planChangeBlocked: false,
  };
}

/**
 * @param {string} organizationId
 * @param {object|null} sub
 * @param {string} currentSku
 * @param {string} newSku
 * @param {boolean} [confirmForfeitReferralCredits]
 */
async function assertPlanChangeAllowedWithReferralCredits({
  organizationId,
  sub,
  currentSku,
  newSku,
  confirmForfeitReferralCredits = false,
}) {
  const creditsAvailableDays = await referralService.getAvailableCreditDays(organizationId);
  const policy = evaluatePlanChangeReferralPolicy({
    sub,
    currentSku,
    newSku,
    creditsAvailableDays,
    confirmForfeitReferralCredits,
  });

  if (!policy.allowed) {
    const err = new Error(policy.error);
    err.statusCode = policy.code === 'referral_credits_forfeit_required' ? 409 : 400;
    err.code = policy.code;
    err.referralPolicy = policy;
    throw err;
  }

  return policy;
}

module.exports = {
  isReferralCreditPeriodLocked,
  deferredChargeDateForReferralCredits,
  evaluatePlanChangeReferralPolicy,
  assertPlanChangeAllowedWithReferralCredits,
};
