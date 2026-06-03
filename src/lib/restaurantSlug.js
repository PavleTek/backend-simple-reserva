'use strict';

const prisma = require('./prisma');

/**
 * Slug URL legible a partir del nombre del local (globalmente único en Restaurant).
 */
function slugifyRestaurantName(name) {
  const base = String(name || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base.slice(0, 80) || 'local';
}

/**
 * @param {string} baseSlug
 * @param {string|null} excludeRestaurantId
 * @returns {Promise<string>}
 */
async function ensureUniqueRestaurantSlug(baseSlug, excludeRestaurantId = null) {
  const root = slugifyRestaurantName(baseSlug);
  let suffix = 0;
  while (suffix < 500) {
    const candidate = suffix === 0 ? root : `${root}-${suffix}`;
    const existing = await prisma.restaurant.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing || (excludeRestaurantId && existing.id === excludeRestaurantId)) {
      return candidate;
    }
    suffix += 1;
  }
  throw new Error('No se pudo generar un enlace público único');
}

module.exports = {
  slugifyRestaurantName,
  ensureUniqueRestaurantSlug,
};
