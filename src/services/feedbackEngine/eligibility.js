'use strict';

const prisma = require('../../lib/prisma');
const { normalizeCustomerEmail, hashEmail } = require('./emailNormalize');
const { computeVisitEnd } = require('./scheduling');

/** Walk-in desde panel */
function isWalkInReservation(reservation) {
  const n = (reservation.notes || '').trim().toLowerCase();
  const name = (reservation.customerName || '').trim();
  return n === 'walk-in' || name === 'Walk-in' || name === 'walk-in';
}

/**
 * @param {object} reservation
 * @param {object} survey - FeedbackSurvey
 * @param {Date} [now]
 * @returns {{ eligible: boolean; skipReason?: string }}
 */
function checkReservationEligibility(reservation, survey, now = new Date()) {
  if (!survey?.enabled) {
    return { eligible: false, skipReason: 'disabled' };
  }

  if (reservation.status === 'cancelled' || reservation.status === 'no_show') {
    return { eligible: false, skipReason: reservation.status };
  }

  if (survey.excludeWalkIns && isWalkInReservation(reservation)) {
    return { eligible: false, skipReason: 'walk_in' };
  }

  const email = normalizeCustomerEmail(reservation.customerEmail);
  if (!email) {
    return { eligible: false, skipReason: 'no_email' };
  }

  if (survey.minPartySize != null && reservation.partySize < survey.minPartySize) {
    return { eligible: false, skipReason: 'party_size' };
  }
  if (survey.maxPartySize != null && reservation.partySize > survey.maxPartySize) {
    return { eligible: false, skipReason: 'party_size' };
  }

  const mode = survey.eligibilityMode || 'confirmed_past_end';

  if (mode === 'completed_only') {
    if (reservation.status !== 'completed') {
      return { eligible: false, skipReason: 'not_completed' };
    }
    // Al marcar completada basta; no exige que la fecha/hora de visita ya haya pasado.
    return { eligible: true };
  }

  if (!['confirmed', 'completed'].includes(reservation.status)) {
    return { eligible: false, skipReason: 'status' };
  }

  const visitEnd = computeVisitEnd(reservation.dateTime, reservation.durationMinutes);
  if (visitEnd >= now) {
    return { eligible: false, skipReason: 'visit_not_ended' };
  }

  return { eligible: true };
}

/**
 * @param {string} restaurantId
 * @param {string} email
 * @param {number} minDays
 * @returns {Promise<boolean>}
 */
async function isOnCooldown(restaurantId, email, minDays) {
  const normalized = normalizeCustomerEmail(email);
  if (!normalized) return false;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (minDays || 14));

  const recent = await prisma.feedbackRequest.findFirst({
    where: {
      restaurantId,
      customerEmailNormalized: normalized,
      sentAt: { gte: cutoff },
      status: { in: ['sent', 'clicked', 'opened', 'completed'] },
    },
    select: { id: true },
  });

  return !!recent;
}

/**
 * @param {string} email
 * @param {string|null} restaurantId
 * @returns {Promise<boolean>}
 */
async function isOptedOut(email, restaurantId) {
  const h = hashEmail(email);
  if (!h) return false;

  const prefs = await prisma.customerFeedbackPreference.findMany({
    where: {
      emailHash: h,
      OR: [{ restaurantId: null }, ...(restaurantId ? [{ restaurantId }] : [])],
    },
    select: { id: true },
  });

  return prefs.length > 0;
}

module.exports = {
  isWalkInReservation,
  checkReservationEligibility,
  isOnCooldown,
  isOptedOut,
};
