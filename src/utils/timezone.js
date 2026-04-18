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

/**
 * Returns the JS-style day of week (0=Sunday … 6=Saturday) for a given date,
 * interpreted in the supplied IANA timezone.
 *
 * IMPORTANT: never use `Date.prototype.getDay()` for restaurant-scoped logic — it
 * returns the day in the SERVER's local timezone, which silently produces the
 * wrong day-of-week whenever the server runs in a timezone different from the
 * restaurant's (e.g. server in UTC, restaurant in America/Santiago at midnight
 * local would give getDay()=Friday for a Saturday booking).
 *
 * Accepts either:
 *   - a "YYYY-MM-DD" string (recommended — unambiguous, timezone-agnostic input)
 *   - a JS Date object (interpreted as a UTC moment in time, then localized)
 *
 * @param {string|Date} dateOrStr
 * @param {string} timezone - IANA timezone string
 * @returns {number} 0..6
 */
function getDayOfWeekInTimezone(dateOrStr, timezone) {
  const dt =
    typeof dateOrStr === 'string'
      ? DateTime.fromISO(dateOrStr, { zone: timezone })
      : DateTime.fromJSDate(dateOrStr).setZone(timezone);
  if (!dt.isValid) {
    throw new Error(`Invalid date for getDayOfWeekInTimezone: ${dt.invalidReason}`);
  }
  // Luxon weekday: 1=Monday .. 7=Sunday → JS getDay: 0=Sunday .. 6=Saturday
  return dt.weekday === 7 ? 0 : dt.weekday;
}

module.exports = {
  COUNTRY_TIMEZONES,
  SUPPORTED_COUNTRIES,
  getEffectiveTimezone,
  parseInTimezone,
  formatInTimezone,
  nowInTimezone,
  getDayOfWeekInTimezone,
};
