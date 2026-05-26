const { DateTime } = require('luxon');

/**
 * Consistent date/time formatting across backend (dd/mm/yyyy, HH:mm 24h).
 * If timezone is provided, formats in that timezone. Otherwise uses server local.
 */
function formatTime(d, timezone) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  
  if (timezone) {
    return DateTime.fromJSDate(date).setZone(timezone).toFormat('HH:mm');
  }
  
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatDateDisplay(d, timezone) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';

  if (timezone) {
    return DateTime.fromJSDate(date).setZone(timezone).toFormat('dd/MM/yyyy');
  }

  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Compact label for notification subjects (hoy / mañana / dd/MM).
 * @param {Date|string|number} d
 * @param {string} [timezone] IANA zone; defaults to America/Santiago
 */
function formatDateShortLabel(d, timezone = 'America/Santiago') {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';

  const dt = DateTime.fromJSDate(date).setZone(timezone);
  const now = DateTime.now().setZone(timezone);
  if (dt.hasSame(now, 'day')) return 'hoy';
  if (dt.hasSame(now.plus({ days: 1 }), 'day')) return 'mañana';
  return dt.toFormat('dd/MM');
}

module.exports = { formatTime, formatDateDisplay, formatDateShortLabel };
