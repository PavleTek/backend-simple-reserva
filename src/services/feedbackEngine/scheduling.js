'use strict';

/**
 * @param {Date|string} dateTime
 * @param {number} durationMinutes
 * @returns {Date}
 */
function computeVisitEnd(dateTime, durationMinutes) {
  const start = new Date(dateTime);
  return new Date(start.getTime() + (durationMinutes || 60) * 60_000);
}

/**
 * @param {Date} visitEnd
 * @param {number} sendDelayMinutes
 * @returns {Date}
 */
const DEFAULT_SEND_DELAY_MINUTES = 60;

function computeScheduledFor(visitEnd, sendDelayMinutes) {
  return new Date(visitEnd.getTime() + (sendDelayMinutes || DEFAULT_SEND_DELAY_MINUTES) * 60_000);
}

function isCompletedOnlyMode(survey) {
  return (survey?.eligibilityMode || 'confirmed_past_end') === 'completed_only';
}

/**
 * scheduledFor según modo: completed_only → ahora; confirmed_past_end → visitEnd + delay.
 */
function resolveScheduledFor(reservation, survey) {
  if (isCompletedOnlyMode(survey) && reservation.status === 'completed') {
    return new Date();
  }
  const visitEnd = computeVisitEnd(reservation.dateTime, reservation.durationMinutes);
  return computeScheduledFor(visitEnd, survey.sendDelayMinutes);
}

function evaluateSendWindowForReservation(reservation, survey, now = new Date()) {
  if (isCompletedOnlyMode(survey)) {
    if (reservation.status !== 'completed') {
      return { inWindow: false, expired: false, tooEarly: true, label: 'pending_completion' };
    }
    return { inWindow: true, expired: false, tooEarly: false, label: 'on_complete' };
  }
  const visitEnd = computeVisitEnd(reservation.dateTime, reservation.durationMinutes);
  if (visitEnd >= now) {
    return { inWindow: false, expired: false, tooEarly: true, label: 'visit_not_ended' };
  }
  const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);
  const w = evaluateSendWindow(scheduledFor, survey.sendWindowMinutes, now);
  let label = 'in_window';
  if (w.tooEarly) label = 'scheduled';
  if (w.expired) label = 'window_expired';
  return { ...w, label, scheduledFor };
}

function shouldAutoSendOnStatusChange(reservation, survey, now = new Date()) {
  if (!survey?.enabled) return false;
  if (isCompletedOnlyMode(survey) && reservation.status === 'completed') return true;
  if (isCompletedOnlyMode(survey)) return false;
  const w = evaluateSendWindowForReservation(reservation, survey, now);
  return w.inWindow;
}

/**
 * @param {Date} scheduledFor
 * @param {number} sendWindowMinutes
 * @param {Date} [now]
 * @returns {{ inWindow: boolean; expired: boolean; tooEarly: boolean }}
 */
function evaluateSendWindow(scheduledFor, sendWindowMinutes, now = new Date()) {
  const start = new Date(scheduledFor).getTime();
  const end = start + (sendWindowMinutes || 240) * 60_000;
  const t = now.getTime();
  return {
    inWindow: t >= start && t <= end,
    expired: t > end,
    tooEarly: t < start,
  };
}

/**
 * @param {Date} sentAt
 * @param {number} ttlDays
 * @param {Date} [now]
 * @returns {boolean}
 */
function isTokenExpired(sentAt, ttlDays, now = new Date()) {
  if (!sentAt) return false;
  const ttlMs = (ttlDays || 14) * 24 * 60 * 60_000;
  return now.getTime() - new Date(sentAt).getTime() > ttlMs;
}

module.exports = {
  DEFAULT_SEND_DELAY_MINUTES,
  computeVisitEnd,
  computeScheduledFor,
  evaluateSendWindow,
  evaluateSendWindowForReservation,
  isCompletedOnlyMode,
  resolveScheduledFor,
  shouldAutoSendOnStatusChange,
  isTokenExpired,
};
