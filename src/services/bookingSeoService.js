'use strict';

const prisma = require('../lib/prisma');
const { hasActiveAccess } = require('./subscriptionService');

function getBookingAppBaseUrl() {
  return (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LADNING_PAGE_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
}

function buildBookingPageUrl(slug) {
  if (!slug) return null;
  return `${getBookingAppBaseUrl()}/restaurant/${slug}`;
}

/**
 * Minimum data required before a restaurant can opt into search indexing.
 */
function hasMinimumSeoData(restaurant) {
  const name = (restaurant.name || '').trim();
  const location = (restaurant.address || restaurant.shortAddress || '').trim();
  return Boolean(name && location);
}

function getMissingSeoRequirements(restaurant, hasAccess) {
  const missing = [];
  if (!hasMinimumSeoData(restaurant)) {
    missing.push('Nombre y dirección en el perfil del local');
  }
  if (!restaurant.isActive || restaurant.isDeleted) {
    missing.push('Local activo');
  }
  if (!hasAccess) {
    missing.push('Suscripción activa');
  }
  return missing;
}

/**
 * Admin-facing SEO status for a restaurant row/card.
 * @param {import('@prisma/client').Restaurant} restaurant
 * @param {boolean} hasAccess
 */
function getBookingSeoAdminMeta(restaurant, hasAccess) {
  const missingRequirements = getMissingSeoRequirements(restaurant, hasAccess);
  const canEnable = missingRequirements.length === 0;
  const bookingPageIndexable = Boolean(restaurant.bookingPageIndexable);
  const isFullyEligible = bookingPageIndexable && canEnable;
  const indexUrl = buildBookingPageUrl(restaurant.slug);

  /** @type {'indexed' | 'ready' | 'incomplete' | 'enabled_blocked'} */
  let status;
  if (bookingPageIndexable && canEnable) status = 'indexed';
  else if (bookingPageIndexable && !canEnable) status = 'enabled_blocked';
  else if (canEnable) status = 'ready';
  else status = 'incomplete';

  return {
    status,
    bookingPageIndexable,
    canEnable,
    isFullyEligible,
    missingRequirements,
    indexUrl,
  };
}

/**
 * @param {import('@prisma/client').Restaurant} restaurant
 */
async function isEligibleForBookingSeoIndex(restaurant) {
  if (!restaurant.bookingPageIndexable) return false;
  if (!restaurant.isActive || restaurant.isDeleted) return false;
  if (!hasMinimumSeoData(restaurant)) return false;
  const access = await hasActiveAccess(restaurant.organizationId);
  return Boolean(access);
}

/**
 * Validates enabling bookingPageIndexable; throws ValidationError message via return.
 */
async function validateEnableBookingPageIndexable(restaurant) {
  if (!hasMinimumSeoData(restaurant)) {
    return {
      ok: false,
      error:
        'Para indexar en buscadores el local necesita nombre y dirección (o dirección corta) en su perfil.',
    };
  }
  if (!restaurant.isActive || restaurant.isDeleted) {
    return { ok: false, error: 'El local debe estar activo.' };
  }
  const access = await hasActiveAccess(restaurant.organizationId);
  if (!access) {
    return {
      ok: false,
      error: 'La organización necesita una suscripción activa para activar la indexación.',
    };
  }
  return { ok: true };
}

/**
 * Slugs eligible for static prerender / sitemap.
 */
async function listIndexableBookingSlugs() {
  const restaurants = await prisma.restaurant.findMany({
    where: {
      bookingPageIndexable: true,
      isActive: true,
      isDeleted: false,
    },
    select: {
      slug: true,
      name: true,
      address: true,
      shortAddress: true,
      organizationId: true,
    },
  });

  const slugs = [];
  for (const r of restaurants) {
    if (!hasMinimumSeoData(r)) continue;
    // eslint-disable-next-line no-await-in-loop
    const access = await hasActiveAccess(r.organizationId);
    if (access) slugs.push(r.slug);
  }
  return slugs;
}

/**
 * All active booking pages (for share previews / prerender), regardless of SEO opt-in.
 */
async function listActiveBookingSlugs() {
  const restaurants = await prisma.restaurant.findMany({
    where: { isActive: true, isDeleted: false },
    select: { slug: true },
    orderBy: { slug: 'asc' },
  });
  return restaurants.map((r) => r.slug);
}

module.exports = {
  getBookingAppBaseUrl,
  buildBookingPageUrl,
  hasMinimumSeoData,
  getMissingSeoRequirements,
  getBookingSeoAdminMeta,
  isEligibleForBookingSeoIndex,
  validateEnableBookingPageIndexable,
  listIndexableBookingSlugs,
  listActiveBookingSlugs,
};
