/**
 * Fin de prueba gratuita al cierre del día calendario (America/Santiago por defecto).
 * La prueba incluye todo el día indicado en trialEndsAt; vence después de esa medianoche.
 */

const { DateTime } = require('luxon');

const TRIAL_TIMEZONE = process.env.TZ || 'America/Santiago';

const DEFAULT_TRIAL_DAYS = 14;

/**
 * @param {Date|string|number} value
 * @returns {import('luxon').DateTime}
 */
function toTrialZone(value) {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: TRIAL_TIMEZONE });
  }
  return DateTime.fromJSDate(new Date(value), { zone: TRIAL_TIMEZONE });
}

/**
 * Último instante del día calendario de trialEndsAt en zona Chile.
 * @param {Date|string} trialEndsAt
 * @returns {Date}
 */
function trialAccessEndsAt(trialEndsAt) {
  return toTrialZone(trialEndsAt).endOf('day').toJSDate();
}

/**
 * Alta + N días calendario, fin del último día (p. ej. 14/05 → fin del 28/05 Chile).
 * @param {Date} [createdAt]
 * @param {number} [days]
 * @returns {Date}
 */
function computeDefaultTrialEndsAt(createdAt = new Date(), days = DEFAULT_TRIAL_DAYS) {
  return toTrialZone(createdAt).plus({ days }).endOf('day').toJSDate();
}

/**
 * @param {Date|string|null|undefined} trialEndsAt
 */
function isTrialExpired(trialEndsAt) {
  if (!trialEndsAt) return false;
  const now = DateTime.now().setZone(TRIAL_TIMEZONE);
  const end = toTrialZone(trialEndsAt).endOf('day');
  return now > end;
}

/**
 * @param {Date|string|null|undefined} trialEndsAt
 */
function isTrialActive(trialEndsAt) {
  if (!trialEndsAt) return false;
  return !isTrialExpired(trialEndsAt);
}

module.exports = {
  TRIAL_TIMEZONE,
  DEFAULT_TRIAL_DAYS,
  trialAccessEndsAt,
  computeDefaultTrialEndsAt,
  isTrialExpired,
  isTrialActive,
};
