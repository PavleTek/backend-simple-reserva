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
function computeScheduledFor(visitEnd, sendDelayMinutes) {
  return new Date(visitEnd.getTime() + (sendDelayMinutes || 75) * 60_000);
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
  computeVisitEnd,
  computeScheduledFor,
  evaluateSendWindow,
  isTokenExpired,
};
