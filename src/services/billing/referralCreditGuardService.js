'use strict';

const { resolvePlanChangeType } = require('../../lib/planDisplayOrder');
const referralService = require('../referralService');
const {
  isInReferralFreeWindow,
  isReferralCreditExtensionScheduled,
} = require('./referralFreeWindowService');

/**
 * Ventana activa o extensión programada tras opt-in en renovación.
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

function requiresForfeitOnUpgrade({
  tierChange,
  confirmForfeitReferralCredits,
  forfeitAppliedPeriod,
  creditsAvailableDays,
}) {
  if (tierChange !== 'upgrade') return null;

  if (!confirmForfeitReferralCredits) {
    return {
      allowed: false,
      code: 'referral_credits_forfeit_required',
      error: 'Al subir de plan perderás tu beneficio de referido.',
      requiresForfeitConfirmation: true,
      forfeitAppliedReferralPeriod: forfeitAppliedPeriod,
      creditsAvailableDays: creditsAvailableDays > 0 ? creditsAvailableDays : undefined,
      upgradeOnlyDuringBenefit: true,
    };
  }

  return {
    allowed: true,
    forfeitAppliedReferralPeriod: forfeitAppliedPeriod,
    forfeitAvailableCredits: !forfeitAppliedPeriod && creditsAvailableDays > 0,
    creditsAvailableDays: creditsAvailableDays > 0 ? creditsAvailableDays : undefined,
    upgradeOnlyDuringBenefit: true,
  };
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
  const tierChange = resolvePlanChangeType(currentSku, newSku);
  const benefitActive = isReferralCreditPeriodLocked(sub);

  if (benefitActive) {
    if (tierChange !== 'upgrade') {
      return {
        allowed: false,
        code: 'referral_upgrade_only',
        error: 'Durante tu beneficio de referido solo puedes subir de plan.',
        upgradeOnlyDuringBenefit: true,
      };
    }
    return (
      requiresForfeitOnUpgrade({
        tierChange,
        confirmForfeitReferralCredits,
        forfeitAppliedPeriod: true,
        creditsAvailableDays: 0,
      }) ?? { allowed: true, forfeitAppliedReferralPeriod: true }
    );
  }

  if (creditsAvailableDays <= 0) {
    return { allowed: true, upgradeOnlyDuringBenefit: false };
  }

  if (tierChange !== 'upgrade') {
    return {
      allowed: false,
      code: 'referral_upgrade_only',
      error: 'Con créditos de referido disponibles solo puedes subir de plan.',
      creditsAvailableDays,
      upgradeOnlyDuringBenefit: true,
    };
  }

  return (
    requiresForfeitOnUpgrade({
      tierChange,
      confirmForfeitReferralCredits,
      forfeitAppliedPeriod: false,
      creditsAvailableDays,
    }) ?? { allowed: true, forfeitAvailableCredits: true, creditsAvailableDays }
  );
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
