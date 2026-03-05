const { DateTime } = require('luxon');

const COUNTRY_TIMEZONES = {
  CL: 'America/Santiago',
  AR: 'America/Argentina/Buenos_Aires',
  UY: 'America/Montevideo',
};

const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_TIMEZONES);

/**
 * Resolves the effective IANA timezone for a restaurant.
 * @param {Object} restaurant - Restaurant object (must have timezone field)
 * @param {string} ownerCountry - Owner's country code (e.g. "CL")
 * @returns {string} IANA timezone string
 */
function getEffectiveTimezone(restaurant, ownerCountry = 'CL') {
  if (restaurant && restaurant.timezone) {
    return restaurant.timezone;
  }
  return COUNTRY_TIMEZONES[ownerCountry] || COUNTRY_TIMEZONES.CL;
}

/**
 * Parses a date and time string in a specific timezone and returns a UTC Date object.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:mm
 * @param {string} timezone - IANA timezone string
 * @returns {Date} JavaScript Date object (UTC)
 */
function parseInTimezone(date, time, timezone) {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`Invalid date/time: ${dt.invalidReason}`);
  }
  return dt.toJSDate();
}

/**
 * Formats a UTC Date in a specific timezone.
 * @param {Date|string} date - UTC Date or ISO string
 * @param {string} timezone - IANA timezone string
 * @param {string} format - Luxon format string
 * @returns {string} Formatted string
 */
function formatInTimezone(date, timezone, format = 'yyyy-MM-dd HH:mm:ss') {
  const dt = date instanceof Date ? DateTime.fromJSDate(date) : DateTime.fromISO(date);
  return dt.setZone(timezone).toFormat(format);
}

/**
 * Returns current time as a Luxon DateTime in the given timezone.
 * @param {string} timezone - IANA timezone string
 * @returns {DateTime}
 */
function nowInTimezone(timezone) {
  return DateTime.now().setZone(timezone);
}

module.exports = {
  COUNTRY_TIMEZONES,
  SUPPORTED_COUNTRIES,
  getEffectiveTimezone,
  parseInTimezone,
  formatInTimezone,
  nowInTimezone,
};
