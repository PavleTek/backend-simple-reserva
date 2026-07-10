'use strict';

/**
 * Micro-cache (TTL 30s) para el lookup slug→restaurant y hasActiveAccess en los
 * endpoints públicos "calientes" del flujo de reservas (availability, day-snapshot,
 * next-available), donde un mismo visitante genera varios requests seguidos al
 * cambiar día/hora/mesa. No se usa en flujos de escritura (crear reserva/hold),
 * que siguen validando acceso en tiempo real contra la DB.
 *
 * Staleness máxima: 30s (consistente con el polling de 30s ya existente en el
 * front). Kill-switch: PUBLIC_BOOKING_CACHE_DISABLED=1 desactiva el cache.
 */

const prisma = require('./prisma');
const { hasActiveAccess } = require('../services/subscriptionService');

const TTL_MS = 30 * 1000;
const CACHE_DISABLED = process.env.PUBLIC_BOOKING_CACHE_DISABLED === '1';

const restaurantBySlugCache = new Map();
const accessByOrgCache = new Map();

/**
 * Restaurante activo por slug, con organization.owner.country (shape usado por
 * availability/day-snapshot/next-available). Solo cachea resultados encontrados;
 * un slug inexistente siempre golpea la DB, para no enmascarar un alta reciente.
 */
async function getCachedRestaurantForBooking(slug) {
  if (!CACHE_DISABLED) {
    const cached = restaurantBySlugCache.get(slug);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      return cached.restaurant;
    }
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true, isDeleted: false },
    include: { organization: { include: { owner: { select: { country: true } } } } },
  });

  if (restaurant && !CACHE_DISABLED) {
    restaurantBySlugCache.set(slug, { ts: Date.now(), restaurant });
  }
  return restaurant;
}

/**
 * hasActiveAccess con TTL 30s por organizationId.
 */
async function getCachedHasActiveAccess(organizationId) {
  if (!CACHE_DISABLED) {
    const cached = accessByOrgCache.get(organizationId);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      return cached.access;
    }
  }

  const access = await hasActiveAccess(organizationId);

  if (!CACHE_DISABLED) {
    accessByOrgCache.set(organizationId, { ts: Date.now(), access });
  }
  return access;
}

module.exports = {
  getCachedRestaurantForBooking,
  getCachedHasActiveAccess,
};
