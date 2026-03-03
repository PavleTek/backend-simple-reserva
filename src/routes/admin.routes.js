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

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
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
    });

    if (!user) throw new NotFoundError('Usuario no encontrado');

    res.json(user);
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const { email, name, lastName } = req.body;
    const userId = req.params.id;

    if (email) {
      const existingUser = await prisma.user.findFirst({
        where: {
          email: { equals: email, mode: 'insensitive' },
          id: { not: userId },
        },
      });
      if (existingUser) {
        return res.status(409).json({ error: 'El email ya está en uso' });
      }
    }

    const updateData = {};
    if (email !== undefined) updateData.email = email.toLowerCase().trim();
    if (name !== undefined) updateData.name = name;
    if (lastName !== undefined) updateData.lastName = lastName;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        lastName: true,
        role: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body;
    const { hashPassword } = require('../utils/password');

    if (!password) {
      return res.status(400).json({ error: 'La contraseña es obligatoria' });
    }

    const hashedPassword = await hashPassword(password);

    await prisma.user.update({
      where: { id: req.params.id },
      data: { hashedPassword },
    });

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body;
    const userId = req.params.id;

    if (!['super_admin', 'owner', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    // Prevent removing the last super_admin
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user.role === 'super_admin' && role !== 'super_admin') {
      const superAdminCount = await prisma.user.count({
        where: { role: 'super_admin' },
      });
      if (superAdminCount <= 1) {
        return res.status(400).json({ error: 'No se puede cambiar el rol del último super administrador' });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, email: true, role: true },
    });

    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('Usuario no encontrado');

    if (user.role === 'super_admin') {
      const superAdminCount = await prisma.user.count({
        where: { role: 'super_admin' },
      });
      if (superAdminCount <= 1) {
        return res.status(400).json({ error: 'No se puede eliminar al último super administrador' });
      }
    }

    await prisma.user.delete({ where: { id: userId } });

    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    next(error);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, lastName, role } = req.body;
    const { hashPassword } = require('../utils/password');

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, contraseña y rol son obligatorios' });
    }

    if (!['super_admin', 'owner', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'El email ya está en uso' });
    }

    const hashedPassword = await hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        hashedPassword,
        name,
        lastName,
        role,
      },
      select: {
        id: true,
        email: true,
        name: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    });

    res.status(201).json(newUser);
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/reset-2fa', async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.params.id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        userEnabledTwoFactor: false,
        twoFactorRecoveryCode: null,
        twoFactorRecoveryCodeExpires: null,
      },
    });

    res.json({ message: '2FA restablecido correctamente' });
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

// ─── Booking Analytics ───────────────────────────────────────────

router.get('/booking-analytics', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, restaurantId, deviceType } = req.query;

    const now = new Date();
    const defaultTo = new Date(now);
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    const from = dateFrom ? new Date(dateFrom) : defaultFrom;
    const to = dateTo ? new Date(dateTo) : defaultTo;

    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
      return res.status(400).json({ error: 'Rango de fechas inválido' });
    }

    const where = {
      timestamp: { gte: from, lte: to },
    };
    if (restaurantId) where.restaurantId = restaurantId;
    if (deviceType) where.deviceType = deviceType;

    const funnelSteps = [
      'booking.page_view',
      'booking.date_selected',
      'booking.party_selected',
      'booking.slots_loaded',
      'booking.time_selected',
      'booking.contact_view',
      'booking.contact_submitted',
      'booking.confirmed',
    ];

    const stepCounts = await Promise.all(
      funnelSteps.map(async (eventName) => {
        const sessions = await prisma.bookingEvent.findMany({
          where: { ...where, eventName },
          select: { sessionId: true },
          distinct: ['sessionId'],
        });
        return { eventName, count: sessions.length };
      })
    );

    const funnel = funnelSteps.map((name, i) => {
      const rec = stepCounts.find((r) => r.eventName === name);
      const count = rec ? rec.count : 0;
      const prevCount = i > 0 ? (stepCounts[i - 1]?.count ?? 0) : count;
      const dropOff = prevCount > 0 ? (1 - count / prevCount) * 100 : 0;
      return { step: name, count, dropOffPercent: i > 0 ? Math.round(dropOff * 10) / 10 : 0 };
    });

    const confirmedEvents = await prisma.bookingEvent.findMany({
      where: { ...where, eventName: 'booking.confirmed' },
      select: { properties: true },
    });

    const elapsedMsList = confirmedEvents
      .map((e) => {
        const p = e.properties;
        if (p && typeof p === 'object' && 'totalElapsedMs' in p) {
          const v = p.totalElapsedMs;
          return typeof v === 'number' && Number.isFinite(v) ? v : null;
        }
        return null;
      })
      .filter((v) => v != null);

    const sorted = [...elapsedMsList].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : null;
    const p75 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.75)] : null;
    const p90 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.9)] : null;
    const sub30Count = elapsedMsList.filter((v) => v < 30000).length;

    const thirtySecondPromise = {
      p50Ms: p50,
      p75Ms: p75,
      p90Ms: p90,
      sub30Count,
      sub30Rate: confirmedEvents.length > 0 ? (sub30Count / confirmedEvents.length) * 100 : 0,
      totalConfirmed: confirmedEvents.length,
    };

    const pageViews = stepCounts.find((r) => r.eventName === 'booking.page_view')?.count ?? 0;

    const [dateChanged, partyChanged, zoneChanged, contactBack, noSlots, submitError, phoneError] = await Promise.all([
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.date_changed' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.party_changed' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.zone_changed' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.contact_back' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.no_slots_shown' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.submit_error' } }),
      prisma.bookingEvent.count({ where: { ...where, eventName: 'booking.phone_validation_error' } }),
    ]);

    const contactViewCount = stepCounts.find((r) => r.eventName === 'booking.contact_view')?.count ?? 0;
    const contactSubmittedCount = stepCounts.find((r) => r.eventName === 'booking.contact_submitted')?.count ?? 0;

    const friction = {
      dateChangeCount: dateChanged,
      partyChangeCount: partyChanged,
      zoneChangeCount: zoneChanged,
      contactBackCount: contactBack,
      backRatePercent: contactViewCount > 0 ? (contactBack / contactViewCount) * 100 : 0,
      noSlotsCount: noSlots,
      noSlotsRatePercent: pageViews > 0 ? (noSlots / pageViews) * 100 : 0,
      submitErrorCount: submitError,
      submitErrorRatePercent: contactSubmittedCount > 0 ? (submitError / contactSubmittedCount) * 100 : 0,
      phoneErrorCount: phoneError,
      phoneErrorRatePercent: contactSubmittedCount > 0 ? (phoneError / contactSubmittedCount) * 100 : 0,
    };

    const deviceCounts = await prisma.bookingEvent.groupBy({
      by: ['deviceType'],
      where: { ...where, eventName: 'booking.page_view' },
      _count: { sessionId: true },
    });

    const deviceBreakdown = deviceCounts.map((d) => ({
      device: d.deviceType || 'unknown',
      sessions: d._count.sessionId,
    }));

    const restaurantsWithNoSlots = await prisma.bookingEvent.groupBy({
      by: ['restaurantId'],
      where: { ...where, eventName: 'booking.no_slots_shown' },
      _count: { id: true },
    });

    const pageViewByRestaurant = await prisma.bookingEvent.groupBy({
      by: ['restaurantId'],
      where: { ...where, eventName: 'booking.page_view' },
      _count: { sessionId: true },
    });

    const restaurantIds = [...new Set(restaurantsWithNoSlots.map((r) => r.restaurantId))];
    const restaurantsMap = {};
    if (restaurantIds.length > 0) {
      const restaurants = await prisma.restaurant.findMany({
        where: { id: { in: restaurantIds } },
        select: { id: true, name: true, slug: true },
      });
      restaurants.forEach((r) => { restaurantsMap[r.id] = r; });
    }

    const zeroAvailabilityRate = restaurantsWithNoSlots.map((r) => {
      const pv = pageViewByRestaurant.find((p) => p.restaurantId === r.restaurantId)?._count?.sessionId ?? 0;
      const noSlotsCount = r._count.id;
      const rate = pv > 0 ? (noSlotsCount / pv) * 100 : 0;
      const rest = restaurantsMap[r.restaurantId];
      return {
        restaurantId: r.restaurantId,
        restaurantName: rest?.name ?? null,
        restaurantSlug: rest?.slug ?? null,
        noSlotsCount,
        pageViews: pv,
        zeroAvailabilityRatePercent: rate,
      };
    });

    const funnelCompletionRate = pageViews > 0 ? ((stepCounts.find((r) => r.eventName === 'booking.confirmed')?.count ?? 0) / pageViews) * 100 : 0;

    res.json({
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      funnel,
      funnelCompletionRate,
      thirtySecondPromise,
      friction,
      deviceBreakdown,
      zeroAvailabilityRate: zeroAvailabilityRate.sort((a, b) => b.zeroAvailabilityRatePercent - a.zeroAvailabilityRatePercent).slice(0, 20),
    });
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
