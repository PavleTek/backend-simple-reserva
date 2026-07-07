'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { NotFoundError, ValidationError } = require('../utils/errors');
const {
  getActiveActivitiesForRestaurant,
  getActivityForRestaurant,
  restaurantHasPublicActivities,
  canUseActivitiesModuleForRestaurant,
} = require('../services/activityService');
const { listSessionsWithAvailability } = require('../services/activitySessionService');
const {
  createActivityBooking,
  cancelActivityBookingByToken,
  createSessionHold,
  getActivityBookingByTokenForPublic,
} = require('../services/activityBookingService');
const { requireAcceptanceOpen } = require('../middleware/acceptance');
const { hasActiveAccess } = require('../services/subscriptionService');
const { resolvePublicRestaurantSlug } = require('../utils/restaurantSlugAliases');

const router = express.Router({ mergeParams: true });

router.param('slug', (req, _res, next, slug) => {
  req.params.slug = resolvePublicRestaurantSlug(slug);
  next();
});

async function resolveRestaurantBySlug(slug) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { slug: resolvePublicRestaurantSlug(slug), isActive: true, isDeleted: false },
  });
  if (!restaurant) throw new NotFoundError('Restaurante no encontrado');
  return restaurant;
}

router.get('/activities', async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req.params.slug);
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurant.id);
    if (!hasModule) return res.json({ activities: [] });
    const activities = await getActiveActivitiesForRestaurant(restaurant.id);
    res.json({ activities });
  } catch (err) {
    next(err);
  }
});

router.get('/activities/:activityId', async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req.params.slug);
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurant.id);
    if (!hasModule) throw new NotFoundError('Actividad no encontrada');
    const activity = await getActivityForRestaurant(req.params.activityId, restaurant.id);
    if (!activity || !activity.isActive) throw new NotFoundError('Actividad no encontrada');
    res.json({ activity });
  } catch (err) {
    next(err);
  }
});

router.get('/activities/:activityId/sessions', async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req.params.slug);
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurant.id);
    if (!hasModule) return res.json({ sessions: [] });
    const activity = await getActivityForRestaurant(req.params.activityId, restaurant.id);
    if (!activity || !activity.isActive) throw new NotFoundError('Actividad no encontrada');
    const { from, to } = req.query;
    const sessions = await listSessionsWithAvailability(activity.id, {
      from,
      to,
      minimumNoticeMinutes: activity.minimumNoticeMinutes ?? 0,
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.post('/activity-sessions/:sessionId/holds', requireAcceptanceOpen, async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req.params.slug);
    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) throw new ValidationError('Reservas no disponibles');
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurant.id);
    if (!hasModule) throw new ValidationError('Actividades no disponibles');
    const { partySize } = req.body;
    const size = parseInt(partySize, 10);
    if (!size || size < 1) throw new ValidationError('Indica el tamaño del grupo');
    const session = await prisma.activitySession.findFirst({
      where: { id: req.params.sessionId, restaurantId: restaurant.id, status: 'SCHEDULED' },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const ttl = restaurant.holdTtlSeconds ?? 300;
    const hold = await createSessionHold(session.id, size, ttl);
    res.status(201).json({ holdToken: hold.holdToken, expiresAt: hold.expiresAt });
  } catch (err) {
    next(err);
  }
});

router.post('/activity-bookings', requireAcceptanceOpen, async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req.params.slug);
    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) throw new ValidationError('Reservas no disponibles');
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurant.id);
    if (!hasModule) throw new ValidationError('Actividades no disponibles');

    const { sessionId, partySize, customerName, customerEmail, customerPhone, notes, holdToken } = req.body;
    if (!sessionId || !customerName || !partySize) {
      throw new ValidationError('Sesión, nombre y tamaño del grupo son obligatorios');
    }

    const booking = await createActivityBooking({
      sessionId,
      partySize: parseInt(partySize, 10),
      customerName,
      customerEmail,
      customerPhone,
      notes,
      source: 'web',
      holdToken: holdToken || null,
    });

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

const activityHoldRouter = express.Router();

activityHoldRouter.delete('/:holdToken', async (req, res, next) => {
  try {
    const { holdToken } = req.params;
    await prisma.activitySessionHold.updateMany({
      where: { holdToken, status: 'active' },
      data: { status: 'released' },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.activityHoldRouter = activityHoldRouter;

const tokenRouter = express.Router();

tokenRouter.get('/token/:secureToken', async (req, res, next) => {
  try {
    const booking = await getActivityBookingByTokenForPublic(req.params.secureToken);
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

tokenRouter.patch('/token/:secureToken/cancel', async (req, res, next) => {
  try {
    const booking = await cancelActivityBookingByToken(req.params.secureToken);
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

module.exports.tokenRouter = tokenRouter;
module.exports.restaurantHasPublicActivities = restaurantHasPublicActivities;
