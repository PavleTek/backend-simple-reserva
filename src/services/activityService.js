'use strict';

const prisma = require('../lib/prisma');
const planService = require('./planService');

async function canUseActivitiesModuleForRestaurant(restaurantId, includeTrial = true) {
  return planService.canUseActivitiesModule(restaurantId, includeTrial);
}

async function getActivityForRestaurant(activityId, restaurantId) {
  return prisma.activity.findFirst({
    where: { id: activityId, restaurantId, isDeleted: false },
    include: { zones: { include: { zone: { select: { id: true, name: true } } } } },
  });
}

async function getActiveActivitiesForRestaurant(restaurantId) {
  return prisma.activity.findMany({
    where: { restaurantId, isActive: true, isDeleted: false },
    orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      zones: { include: { zone: { select: { id: true, name: true } } } },
    },
  });
}

async function restaurantHasPublicActivities(restaurantId) {
  const allowed = await canUseActivitiesModuleForRestaurant(restaurantId);
  if (!allowed) return false;
  const count = await prisma.activity.count({
    where: { restaurantId, isActive: true, isDeleted: false },
  });
  return count > 0;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function ensureUniqueSlug(restaurantId, baseSlug, excludeId = null) {
  let slug = baseSlug || 'actividad';
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
    const existing = await prisma.activity.findFirst({
      where: {
        restaurantId,
        slug: candidate,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (!existing) return candidate;
    suffix += 1;
  }
}

module.exports = {
  canUseActivitiesModuleForRestaurant,
  getActivityForRestaurant,
  getActiveActivitiesForRestaurant,
  restaurantHasPublicActivities,
  slugify,
  ensureUniqueSlug,
};
