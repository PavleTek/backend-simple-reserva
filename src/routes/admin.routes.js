const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError } = require('../utils/errors');

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
