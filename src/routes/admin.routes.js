const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');

const router = express.Router();

router.use(authenticateToken);
router.use(authenticateRoles(['super_admin']));

// ─── Restaurants ─────────────────────────────────────────────────

router.get('/restaurants', async (req, res, next) => {
  try {
    const { search } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [restaurants, total] = await Promise.all([
      prisma.restaurant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { reservations: true, userRestaurants: true } },
          subscriptions: true,
        },
      }),
      prisma.restaurant.count({ where }),
    ]);

    res.json(paginatedResponse(restaurants, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.get('/restaurants/:id', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      include: {
        zones: { include: { tables: true } },
        userRestaurants: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                lastName: true,
                lastLogin: true,
                createdAt: true,
              },
            },
          },
        },
        subscriptions: true,
      },
    });

    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
});

router.patch('/restaurants/:id', async (req, res, next) => {
  try {
    const { isActive } = req.body;

    const restaurant = await prisma.restaurant.update({
      where: { id: req.params.id },
      data: { isActive },
    });

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
});

// ─── Users ───────────────────────────────────────────────────────

router.get('/users', async (req, res, next) => {
  try {
    const { search, role } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const where = {};
    if (role) where.role = role;
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          lastName: true,
          role: true,
          userRestaurants: {
            include: { restaurant: { select: { id: true, name: true } } },
          },
          lastLogin: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(paginatedResponse(users, total, page, limit));
  } catch (error) {
    next(error);
  }
});

// ─── Plan Config (super admin) ───────────────────────────────────

router.get('/plans', async (req, res, next) => {
  try {
    const configs = await prisma.planConfig.findMany({
      orderBy: { plan: 'asc' },
    });
    res.json(configs);
  } catch (error) {
    next(error);
  }
});

router.get('/plans/:plan', async (req, res, next) => {
  try {
    const config = await prisma.planConfig.findUnique({
      where: { plan: req.params.plan },
    });
    if (!config) throw new NotFoundError('Plan no encontrado');
    res.json(config);
  } catch (error) {
    next(error);
  }
});

router.patch('/plans/:plan', async (req, res, next) => {
  try {
    const { plan } = req.params;
    if (!planService.VALID_PLANS.includes(plan)) {
      throw new ValidationError('Plan inválido');
    }
    const existing = await prisma.planConfig.findUnique({ where: { plan } });
    if (!existing) throw new NotFoundError('Plan no encontrado');

    const allowed = [
      'smsConfirmations', 'smsReminders', 'whatsappConfirmations', 'whatsappReminders',
      'whatsappModificationAlerts', 'menuPdf', 'advancedBookingSettings', 'brandingRemoval',
      'analyticsWeekly', 'analyticsMonthly', 'crossLocationDashboard', 'prioritySupport',
      'maxLocations', 'maxZones', 'maxTables', 'maxTeamMembers',
      'biweeklyPriceCLP', 'currency', 'billingFrequencyDays',
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    const config = await prisma.planConfig.update({
      where: { plan },
      data,
    });
    planService.invalidateCache();
    res.json(config);
  } catch (error) {
    next(error);
  }
});

// ─── Plan Overrides (super admin) ─────────────────────────────────

router.get('/plan-overrides', async (req, res, next) => {
  try {
    const overrides = await prisma.planOverride.findMany({
      include: { user: { select: { id: true, email: true, name: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(overrides);
  } catch (error) {
    next(error);
  }
});

router.post('/plan-overrides', async (req, res, next) => {
  try {
    const { userId, biweeklyPriceCLP, expiresAt, reason, ...featureLimits } = req.body;
    if (!userId) throw new ValidationError('userId es requerido');

    const override = await prisma.planOverride.upsert({
      where: { userId },
      update: {
        ...(biweeklyPriceCLP !== undefined && { biweeklyPriceCLP }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
        ...(reason !== undefined && { reason }),
        ...featureLimits,
      },
      create: {
        userId,
        biweeklyPriceCLP: biweeklyPriceCLP ?? null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        reason: reason || null,
        ...featureLimits,
      },
    });
    planService.invalidateCache(userId);
    res.status(201).json(override);
  } catch (error) {
    next(error);
  }
});

router.delete('/plan-overrides/:userId', async (req, res, next) => {
  try {
    await prisma.planOverride.delete({
      where: { userId: req.params.userId },
    });
    planService.invalidateCache(req.params.userId);
    res.json({ message: 'Override eliminado' });
  } catch (error) {
    if (error.code === 'P2025') throw new NotFoundError('Override no encontrado');
    next(error);
  }
});

// ─── Subscriptions ───────────────────────────────────────────────

router.get('/subscriptions', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { restaurant: { select: { name: true } } },
      }),
      prisma.subscription.count(),
    ]);

    res.json(paginatedResponse(subscriptions, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.patch('/subscriptions/:id', async (req, res, next) => {
  try {
    const { plan, status, endDate } = req.body;

    const data = {};
    if (plan !== undefined) data.plan = plan;
    if (status !== undefined) data.status = status;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;

    const subscription = await prisma.subscription.update({
      where: { id: req.params.id },
      data,
      include: { restaurant: { select: { name: true } } },
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// ─── Analytics ───────────────────────────────────────────────────

router.get('/analytics', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalRestaurants,
      totalActiveRestaurants,
      totalUsers,
      totalReservations,
      reservationsThisMonth,
      activeSubscriptions,
    ] = await Promise.all([
      prisma.restaurant.count(),
      prisma.restaurant.count({ where: { isActive: true } }),
      prisma.user.count(),
      prisma.reservation.count(),
      prisma.reservation.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.subscription.count({ where: { status: 'active' } }),
    ]);

    res.json({
      totalRestaurants,
      totalActiveRestaurants,
      totalUsers,
      totalReservations,
      reservationsThisMonth,
      activeSubscriptions,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
