'use strict';

/**
 * Base URL del panel restaurante (sin barra final).
 */
function getRestaurantPortalBase() {
  const raw =
    process.env.FRONTEND_RESTAURANT_PORTAL_URL ||
    process.env.RESTAURANT_PANEL_URL ||
    process.env.BOOKING_BASE_URL ||
    'http://localhost:5175';
  return String(raw).replace(/\/$/, '');
}

/**
 * @param {Object} [opts]
 * @param {'today'|'tomorrow'|'week'|'all'} [opts.view]
 * @param {string} [opts.date] - YYYY-MM-DD (prioridad sobre view)
 * @returns {string}
 */
function reservationsListUrl(opts = {}) {
  const base = getRestaurantPortalBase();
  const path = `${base}/reservations`;
  const params = new URLSearchParams();
  if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    params.set('date', opts.date);
  } else if (opts.view && opts.view !== 'today') {
    params.set('view', opts.view);
  } else if (opts.view === 'today') {
    params.set('view', 'today');
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * @returns {string}
 */
function billingUrl() {
  return `${getRestaurantPortalBase()}/billing`;
}

module.exports = {
  getRestaurantPortalBase,
  reservationsListUrl,
  billingUrl,
};
