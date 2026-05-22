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
  const info = await getCooldownInfoForEmail(restaurantId, email, minDays);
  return info.onCooldown;
}

/**
 * Último envío al correo y fecha en que termina la espera entre encuestas.
 * @param {string} restaurantId
 * @param {string} email
 * @param {number} minDays
 * @returns {Promise<{ onCooldown: boolean; cooldownUntil: string|null; lastSentAt: string|null }>}
 */
async function getCooldownInfoForEmail(restaurantId, email, minDays) {
  const normalized = normalizeCustomerEmail(email);
  if (!normalized) {
    return { onCooldown: false, cooldownUntil: null, lastSentAt: null };
  }
  const map = await getCooldownInfoByEmail(restaurantId, [normalized], minDays);
  return map.get(normalized) ?? { onCooldown: false, cooldownUntil: null, lastSentAt: null };
}

/**
 * @param {string} restaurantId
 * @param {string[]} emails normalized
 * @param {number} minDays
 * @returns {Promise<Map<string, { onCooldown: boolean; cooldownUntil: string|null; lastSentAt: string|null }>>}
 */
async function getCooldownInfoByEmail(restaurantId, emails, minDays) {
  const min = Math.max(1, minDays || 14);
  const normalized = [...new Set(emails.map(normalizeCustomerEmail).filter(Boolean))];
  const result = new Map();
  if (normalized.length === 0) return result;

  const recent = await prisma.feedbackRequest.findMany({
    where: {
      restaurantId,
      customerEmailNormalized: { in: normalized },
      sentAt: { not: null },
      status: { in: ['sent', 'clicked', 'opened', 'completed'] },
    },
    select: { customerEmailNormalized: true, sentAt: true },
    orderBy: { sentAt: 'desc' },
  });

  const now = Date.now();
  for (const row of recent) {
    const key = row.customerEmailNormalized;
    if (!key || result.has(key) || !row.sentAt) continue;
    const cooldownUntil = new Date(row.sentAt);
    cooldownUntil.setDate(cooldownUntil.getDate() + min);
    const untilIso = cooldownUntil.toISOString();
    result.set(key, {
      onCooldown: cooldownUntil.getTime() > now,
      cooldownUntil: untilIso,
      lastSentAt: row.sentAt.toISOString(),
    });
  }
  return result;
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

/**
 * Emails (hash) que rechazaron recibir más encuestas (global o por local).
 * @param {string} restaurantId
 * @param {string[]} emailHashes
 * @returns {Promise<Set<string>>}
 */
async function getOptedOutEmailHashes(restaurantId, emailHashes) {
  const unique = [...new Set(emailHashes.filter(Boolean))];
  if (unique.length === 0) return new Set();

  const prefs = await prisma.customerFeedbackPreference.findMany({
    where: {
      emailHash: { in: unique },
      OR: [{ restaurantId: null }, { restaurantId }],
    },
    select: { emailHash: true },
  });

  return new Set(prefs.map((p) => p.emailHash));
}

module.exports = {
  isWalkInReservation,
  checkReservationEligibility,
  isOnCooldown,
  getCooldownInfoForEmail,
  getCooldownInfoByEmail,
  isOptedOut,
  getOptedOutEmailHashes,
};
