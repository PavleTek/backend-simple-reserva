const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');
const paymentReceiptService = require('../services/paymentReceiptService');
const { sortPlansByDisplayOrder } = require('../lib/planDisplayOrder');
const whatsappService = require('../services/whatsappService');

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
          _count: { select: { reservations: true, managerAssignments: true } },
          organization: { include: { owner: true } },
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
        organization: {
          include: {
            owner: {
              select: {
                id: true,
                email: true,
                name: true,
                lastName: true,
                lastLogin: true,
                createdAt: true,
              },
            },
            managers: {
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
              }
            },
            customPlan: true,
          },
        },
        menus: true,
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

// ─── Planes personalizados por organización ────────────────────────────────

/**
 * GET /admin/organizations/:organizationId/custom-plan
 * Devuelve el plan personalizado asignado a la organización, si existe.
 */
router.get('/organizations/:organizationId/custom-plan', async (req, res, next) => {
  try {
    const { organizationId } = req.params;
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      include: { customPlan: true },
    });
    if (!org) throw new NotFoundError('Organización no encontrada');
    res.json({ customPlan: org.customPlan ?? null });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /admin/organizations/:organizationId/assign-plan
 * Asigna un plan personalizado (no público) a una organización.
 * Body: { planId: string } — ID del Plan en DB.
 *       { planId: null }   — elimina el plan personalizado.
 */
router.post('/organizations/:organizationId/assign-plan', async (req, res, next) => {
  try {
    const { organizationId } = req.params;
    const { planId } = req.body;

    const org = await prisma.restaurantOrganization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundError('Organización no encontrada');

    if (planId !== null && planId !== undefined) {
      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundError('Plan no encontrado');
    }

    const updated = await prisma.restaurantOrganization.update({
      where: { id: organizationId },
      data: { customPlanId: planId ?? null },
      include: { customPlan: true },
    });

    planService.invalidateCache(organizationId);
    res.json({ customPlan: updated.customPlan ?? null });
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
          ownedOrganization: {
            include: { restaurants: { select: { id: true, name: true } } }
          },
          managedOrganizations: {
            include: { 
              organization: { include: { restaurants: { select: { id: true, name: true } } } }
            }
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

// ─── Plans (super admin) ───────────────────────────────────

router.get('/plans', async (req, res, next) => {
  try {
    const plans = sortPlansByDisplayOrder(await prisma.plan.findMany());
    res.json(plans);
  } catch (error) {
    next(error);
  }
});

router.post('/plans', async (req, res, next) => {
  try {
    const allowed = [
      'productSKU', 'name', 'description', 'type', 'isDefault',
      'maxRestaurants', 'maxZonesPerRestaurant', 'maxTables', 'maxTeamMembers',
      'whatsappFeatures', 'googleReserveIntegration', 'multipleMenu', 'prioritySupport',
      'priceCLP', 'priceUSD', 'priceEUR', 'billingFrequency', 'billingFrequencyType',
      'freeTrialLength', 'freeTrialLengthUnit'
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    
    if (!data.productSKU || !data.name) {
      throw new ValidationError('productSKU y name son obligatorios');
    }

    const plan = await prisma.plan.create({ data });
    planService.invalidateCache();

    const finalPlan = await prisma.plan.findUnique({ where: { id: plan.id } });
    res.status(201).json(finalPlan);
  } catch (error) {
    next(error);
  }
});

router.get('/plans/:id', async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({
      where: { id: req.params.id },
    });
    if (!plan) throw new NotFoundError('Plan no encontrado');
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

router.patch('/plans/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Plan no encontrado');

    const allowed = [
      'name', 'description', 'type', 'isDefault',
      'maxRestaurants', 'maxZonesPerRestaurant', 'maxTables', 'maxTeamMembers',
      'whatsappFeatures', 'googleReserveIntegration', 'multipleMenu', 'prioritySupport',
      'priceCLP', 'priceUSD', 'priceEUR', 'billingFrequency', 'billingFrequencyType',
      'freeTrialLength', 'freeTrialLengthUnit'
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    const plan = await prisma.plan.update({
      where: { id },
      data,
    });
    planService.invalidateCache();

    const finalPlan = await prisma.plan.findUnique({ where: { id: plan.id } });
    res.json(finalPlan);
  } catch (error) {
    next(error);
  }
});

router.delete('/plans/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Plan no encontrado');
    
    if (existing.isDefault) {
      throw new ValidationError('No se puede eliminar un plan por defecto');
    }

    await prisma.plan.delete({ where: { id } });
    planService.invalidateCache();
    res.json({ message: 'Plan eliminado' });
  } catch (error) {
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
        ownedOrganization: {
          include: { restaurants: { select: { id: true, name: true } } }
        },
        managedOrganizations: {
          include: { 
            organization: { include: { restaurants: { select: { id: true, name: true } } } }
          }
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

    const { getPasswordPolicyError } = require('../utils/passwordPolicy');
    const pwdErr = getPasswordPolicyError(password);
    if (pwdErr) {
      return res.status(400).json({ error: pwdErr });
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

    if (!['super_admin', 'restaurant_owner', 'restaurant_manager'].includes(role)) {
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

// ─── Subscriptions ───────────────────────────────────────────────

router.get('/subscriptions', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { 
          organization: { include: { restaurants: { select: { name: true } } } },
          plan: true
        },
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
    const { planId, status, endDate } = req.body;

    const data = {};
    if (planId !== undefined) data.planId = planId;
    if (status !== undefined) data.status = status;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;

    const subscription = await prisma.subscription.update({
      where: { id: req.params.id },
      data,
      include: { 
        organization: { select: { name: true } },
        plan: true
      },
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// ─── Payment Receipts ─────────────────────────────────────────────

router.get('/payment-receipts', async (req, res, next) => {
  try {
    const result = await paymentReceiptService.listReceipts(req.query, req.query);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch('/payment-receipts/:id', async (req, res, next) => {
  try {
    const { legalReceiptSent, notes } = req.body;
    const data = {};
    if (legalReceiptSent !== undefined) {
      data.legalReceiptSent = legalReceiptSent;
      if (legalReceiptSent) {
        data.legalReceiptSentAt = new Date();
        data.legalReceiptSentBy = req.user.id;
      } else {
        data.legalReceiptSentAt = null;
        data.legalReceiptSentBy = null;
      }
    }
    if (notes !== undefined) data.notes = notes;

    const receipt = await prisma.paymentReceipt.update({
      where: { id: req.params.id },
      data,
      include: {
        organization: { select: { name: true } },
        plan: { select: { name: true } },
      },
    });
    res.json(receipt);
  } catch (error) {
    next(error);
  }
});

router.post('/payment-receipts/:id/toggle-sent', async (req, res, next) => {
  try {
    const existing = await prisma.paymentReceipt.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw new NotFoundError('Comprobante no encontrado');

    let receipt;
    if (existing.legalReceiptSent) {
      receipt = await paymentReceiptService.markLegalReceiptUnsent(req.params.id);
    } else {
      receipt = await paymentReceiptService.markLegalReceiptSent(req.params.id, req.user.id);
    }
    res.json(receipt);
  } catch (error) {
    next(error);
  }
});

// ─── Checkout Sessions ───────────────────────────────────────────

router.get('/checkout-sessions', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { organizationId, status } = req.query;

    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (status) where.status = status;

    const [sessions, total] = await Promise.all([
      prisma.checkoutSession.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          organization: { select: { name: true } },
          user: { select: { email: true, name: true, lastName: true } },
          plan: { select: { name: true } },
        },
      }),
      prisma.checkoutSession.count({ where }),
    ]);

    res.json(paginatedResponse(sessions, total, page, limit));
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

// ─── Reservation Analytics ───────────────────────────────────────

/** Días YYYY-MM-DD desde/hasta (inclusive), en UTC. */
function enumerateUtcDaysInclusive(fromStr, toStr) {
  const out = [];
  const cur = new Date(`${fromStr}T00:00:00.000Z`);
  const end = new Date(`${toStr}T00:00:00.000Z`);
  if (cur > end) return out;
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

router.get('/reservation-analytics', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, restaurantId } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom y dateTo son requeridos' });
    }

    const fromStr = String(dateFrom).slice(0, 10);
    const toStr = String(dateTo).slice(0, 10);
    const fromParts = fromStr.split('-').map(Number);
    const toParts = toStr.split('-').map(Number);
    if (fromParts.length !== 3 || toParts.length !== 3 || fromParts.some(Number.isNaN) || toParts.some(Number.isNaN)) {
      return res.status(400).json({ error: 'Formato de fecha inválido (usa YYYY-MM-DD)' });
    }

    // Límites en UTC para alinear con columnas @db.Date y rangos inclusivos
    const from = new Date(Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2], 0, 0, 0, 0));
    const to = new Date(Date.UTC(toParts[0], toParts[1] - 1, toParts[2], 23, 59, 59, 999));

    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
      return res.status(400).json({ error: 'Rango de fechas inválido' });
    }

    const dateFilter = { gte: from, lte: to };

    const restaurantsPromise = prisma.restaurant.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    // Serie diaria desde `Reservation` (fecha UTC del día de creación), alineada con el resumen y rankings.
    const dailyRows = restaurantId
      ? await prisma.$queryRaw`
          SELECT (("createdAt" AT TIME ZONE 'UTC')::date)::text AS day, COUNT(*)::int AS cnt
          FROM "Reservation"
          WHERE "createdAt" >= ${from}
            AND "createdAt" <= ${to}
            AND "restaurantId" = ${String(restaurantId)}
          GROUP BY 1
          ORDER BY 1
        `
      : await prisma.$queryRaw`
          SELECT (("createdAt" AT TIME ZONE 'UTC')::date)::text AS day, COUNT(*)::int AS cnt
          FROM "Reservation"
          WHERE "createdAt" >= ${from}
            AND "createdAt" <= ${to}
          GROUP BY 1
          ORDER BY 1
        `;

    const countByDay = new Map(dailyRows.map((r) => [r.day, r.cnt]));
    const dayKeys = enumerateUtcDaysInclusive(fromStr, toStr);
    const filledSeries = dayKeys.map((d) => ({
      date: d,
      reservationCount: countByDay.get(d) ?? 0,
    }));

    const reservationWhere = {
      createdAt: dateFilter,
      ...(restaurantId ? { restaurantId: String(restaurantId) } : {}),
    };

    const [byStatus, bySource, topGroups, agg, restaurants] = await Promise.all([
      prisma.reservation.groupBy({
        by: ['status'],
        where: reservationWhere,
        _count: { _all: true },
      }),
      prisma.reservation.groupBy({
        by: ['source'],
        where: reservationWhere,
        _count: { _all: true },
      }),
      restaurantId
        ? Promise.resolve([])
        : prisma.reservation.groupBy({
            by: ['restaurantId'],
            where: reservationWhere,
            _count: { _all: true },
            orderBy: { _count: { restaurantId: 'desc' } },
            take: 15,
          }),
      prisma.reservation.aggregate({
        where: reservationWhere,
        _count: { _all: true },
        _sum: { partySize: true },
        _avg: { partySize: true },
      }),
      restaurantsPromise,
    ]);

    const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
    const sourceCounts = Object.fromEntries(bySource.map((r) => [r.source, r._count._all]));

    let topRestaurants = [];
    if (topGroups.length > 0) {
      const ids = topGroups.map((g) => g.restaurantId);
      const names = await prisma.restaurant.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      const nameById = Object.fromEntries(names.map((n) => [n.id, n.name]));
      const totalAll = agg._count._all;
      topRestaurants = topGroups.map((g) => ({
        restaurantId: g.restaurantId,
        name: nameById[g.restaurantId] ?? g.restaurantId,
        count: g._count._all,
        sharePercent: totalAll > 0 ? Math.round((g._count._all / totalAll) * 1000) / 10 : 0,
      }));
    }

    res.json({
      data: filledSeries,
      restaurants,
      summary: {
        totalReservations: agg._count._all,
        totalCovers: agg._sum.partySize ?? 0,
        avgPartySize:
          agg._count._all > 0 && agg._avg.partySize != null
            ? Math.round(agg._avg.partySize * 10) / 10
            : null,
        byStatus: statusCounts,
        bySource: sourceCounts,
      },
      topRestaurants,
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

// ─── App Configuration ───────────────────────────────────────────

// ─── Email Senders ───────────────────────────────────────────────

router.get('/email-domains', async (req, res, next) => {
  try {
    const domains = await prisma.emailDomain.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { senders: true } } },
    });
    res.json(domains);
  } catch (error) {
    next(error);
  }
});

router.post('/email-domains', async (req, res, next) => {
  try {
    const { domain } = req.body;

    if (!domain || typeof domain !== 'string' || !domain.includes('.') || domain.includes('@')) {
      throw new ValidationError('Dominio inválido');
    }

    const normalizedDomain = domain.toLowerCase().trim();

    const existing = await prisma.emailDomain.findUnique({
      where: { domain: normalizedDomain },
    });

    if (existing) {
      throw new ValidationError('Este dominio ya está registrado');
    }

    const newDomain = await prisma.emailDomain.create({
      data: { domain: normalizedDomain },
    });

    res.status(201).json(newDomain);
  } catch (error) {
    next(error);
  }
});

router.delete('/email-domains/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if any sender in this domain is in use by config
    const sendersInDomain = await prisma.emailSender.findMany({
      where: { domainId: id },
      select: { id: true },
    });

    const senderIds = sendersInDomain.map(s => s.id);
    const config = await prisma.configuration.findFirst();

    if (config && (senderIds.includes(config.recoveryEmailSenderId) || senderIds.includes(config.reservationEmailSenderId))) {
      throw new ValidationError('No se puede eliminar el dominio porque uno de sus remitentes está en uso por la configuración del sistema');
    }

    // Cascade delete is handled by Prisma (onDelete: Cascade)
    await prisma.emailDomain.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/email-senders', async (req, res, next) => {
  try {
    const senders = await prisma.emailSender.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(senders);
  } catch (error) {
    next(error);
  }
});

router.post('/email-senders', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      throw new ValidationError('Email inválido');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const domainPart = normalizedEmail.split('@')[1];

    // Find if the domain is authorized
    const domain = await prisma.emailDomain.findUnique({
      where: { domain: domainPart },
    });

    if (!domain) {
      throw new ValidationError(`El dominio @${domainPart} no está autorizado. Agrégalo primero.`);
    }

    const existing = await prisma.emailSender.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      throw new ValidationError('Este email ya está registrado como remitente');
    }

    const sender = await prisma.emailSender.create({
      data: { 
        email: normalizedEmail,
        domainId: domain.id,
      },
    });

    res.status(201).json(sender);
  } catch (error) {
    next(error);
  }
});

router.delete('/email-senders/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const config = await prisma.configuration.findFirst();
    if (config && (config.recoveryEmailSenderId === id || config.reservationEmailSenderId === id)) {
      throw new ValidationError('No se puede eliminar un remitente que está en uso por la configuración del sistema');
    }

    await prisma.emailSender.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ─── App Configuration ───────────────────────────────────────────

router.get('/config', async (req, res, next) => {
  try {
    const config = await prisma.configuration.findFirst();
    res.json(config);
  } catch (error) {
    next(error);
  }
});

router.patch('/config', async (req, res, next) => {
  try {
    const { 
      dashboardPollingIntervalSeconds, 
      recoveryEmailSenderId, 
      reservationEmailSenderId 
    } = req.body;

    if (dashboardPollingIntervalSeconds !== undefined) {
      if (typeof dashboardPollingIntervalSeconds !== 'number' || dashboardPollingIntervalSeconds < 5 || dashboardPollingIntervalSeconds > 300) {
        throw new ValidationError('El intervalo de sondeo debe ser un número entre 5 y 300 segundos');
      }
    }

    if (recoveryEmailSenderId) {
      const sender = await prisma.emailSender.findUnique({ where: { id: recoveryEmailSenderId } });
      if (!sender) throw new ValidationError('El remitente de recuperación no existe');
    }

    if (reservationEmailSenderId) {
      const sender = await prisma.emailSender.findUnique({ where: { id: reservationEmailSenderId } });
      if (!sender) throw new ValidationError('El remitente de reservas no existe');
    }

    const currentConfig = await prisma.configuration.findFirst();
    if (!currentConfig) {
      throw new NotFoundError('Configuración no encontrada');
    }

    const updated = await prisma.configuration.update({
      where: { id: currentConfig.id },
      data: {
        ...(dashboardPollingIntervalSeconds !== undefined && { dashboardPollingIntervalSeconds }),
        ...(recoveryEmailSenderId !== undefined && { recoveryEmailSenderId }),
        ...(reservationEmailSenderId !== undefined && { reservationEmailSenderId }),
      },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────

router.get('/whatsapp/config', async (req, res, next) => {
  try {
    const config = await prisma.configuration.findFirst();
    if (!config) {
      throw new NotFoundError('Configuración no encontrada');
    }
    res.json({
      whatsappAuthToken: whatsappService.maskToken(config.whatsappAuthToken),
      whatsappSendingPhoneNumberId: config.whatsappSendingPhoneNumberId,
      whatsappBusinessAccountId: config.whatsappBusinessAccountId,
      whatsappApiVersion: config.whatsappApiVersion || 'v21.0',
      whatsappTemplateLanguage: config.whatsappTemplateLanguage || 'es',
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/whatsapp/config', async (req, res, next) => {
  try {
    const {
      whatsappAuthToken,
      whatsappSendingPhoneNumberId,
      whatsappBusinessAccountId,
      whatsappApiVersion,
      whatsappTemplateLanguage,
    } = req.body;

    const currentConfig = await prisma.configuration.findFirst();
    if (!currentConfig) {
      throw new NotFoundError('Configuración no encontrada');
    }

    const data = {};
    if (whatsappAuthToken !== undefined) {
      if (typeof whatsappAuthToken !== 'string') {
        throw new ValidationError('whatsappAuthToken debe ser texto');
      }
      data.whatsappAuthToken = whatsappAuthToken.trim() === '' ? null : whatsappAuthToken.trim();
    }
    if (whatsappSendingPhoneNumberId !== undefined) {
      if (whatsappSendingPhoneNumberId !== null && typeof whatsappSendingPhoneNumberId !== 'string') {
        throw new ValidationError('whatsappSendingPhoneNumberId debe ser texto');
      }
      data.whatsappSendingPhoneNumberId =
        whatsappSendingPhoneNumberId == null || String(whatsappSendingPhoneNumberId).trim() === ''
          ? null
          : String(whatsappSendingPhoneNumberId).trim();
    }
    if (whatsappBusinessAccountId !== undefined) {
      if (whatsappBusinessAccountId !== null && typeof whatsappBusinessAccountId !== 'string') {
        throw new ValidationError('whatsappBusinessAccountId debe ser texto');
      }
      data.whatsappBusinessAccountId =
        whatsappBusinessAccountId == null || String(whatsappBusinessAccountId).trim() === ''
          ? null
          : String(whatsappBusinessAccountId).trim();
    }
    if (whatsappApiVersion !== undefined) {
      if (typeof whatsappApiVersion !== 'string' || !/^v\d+\.\d+(\.\d+)?$/.test(whatsappApiVersion.trim())) {
        throw new ValidationError('whatsappApiVersion debe ser como v21.0');
      }
      data.whatsappApiVersion = whatsappApiVersion.trim();
    }
    if (whatsappTemplateLanguage !== undefined) {
      if (typeof whatsappTemplateLanguage !== 'string' || whatsappTemplateLanguage.trim().length < 2) {
        throw new ValidationError('whatsappTemplateLanguage inválido');
      }
      data.whatsappTemplateLanguage = whatsappTemplateLanguage.trim();
    }

    const updated = await prisma.configuration.update({
      where: { id: currentConfig.id },
      data,
    });

    res.json({
      whatsappAuthToken: whatsappService.maskToken(updated.whatsappAuthToken),
      whatsappSendingPhoneNumberId: updated.whatsappSendingPhoneNumberId,
      whatsappBusinessAccountId: updated.whatsappBusinessAccountId,
      whatsappApiVersion: updated.whatsappApiVersion || 'v21.0',
      whatsappTemplateLanguage: updated.whatsappTemplateLanguage || 'es',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/whatsapp/test-connection', async (req, res, next) => {
  try {
    const result = await whatsappService.testWhatsAppConnection();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/whatsapp/templates', async (req, res, next) => {
  try {
    const rows = await prisma.whatsAppTemplate.findMany({
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
      select: {
        id: true,
        metaId: true,
        name: true,
        language: true,
        category: true,
        status: true,
        bodyText: true,
        lastSyncedAt: true,
        updatedAt: true,
      },
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/whatsapp/templates', async (req, res, next) => {
  try {
    const { name, category, language, bodyText, headerText, footerText } = req.body;

    if (!name || typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name.trim())) {
      throw new ValidationError('El nombre debe ser snake_case (solo letras minúsculas, números y guiones bajos)');
    }
    const validCategories = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
    if (!category || !validCategories.includes(String(category).toUpperCase())) {
      throw new ValidationError(`Categoría inválida. Opciones: ${validCategories.join(', ')}`);
    }
    if (!language || typeof language !== 'string' || language.trim().length < 2) {
      throw new ValidationError('Idioma inválido (ej. es, es_LA, en_US)');
    }
    if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
      throw new ValidationError('El texto del cuerpo es obligatorio');
    }

    const result = await whatsappService.createTemplateOnMeta({
      name: name.trim(),
      category: String(category).toUpperCase(),
      language: language.trim(),
      bodyText: bodyText.trim(),
      headerText: headerText || null,
      footerText: footerText || null,
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'Error al crear la plantilla en Meta');
    }

    // Save to local DB immediately (status will be PENDING from Meta)
    const now = new Date();
    const saved = await prisma.whatsAppTemplate.upsert({
      where: { name_language: { name: name.trim(), language: language.trim() } },
      create: {
        metaId: result.metaId || null,
        name: name.trim(),
        language: language.trim(),
        category: String(category).toUpperCase(),
        status: result.status || 'PENDING',
        bodyText: bodyText.trim(),
        componentsJson: null,
        lastSyncedAt: now,
      },
      update: {
        metaId: result.metaId || undefined,
        category: String(category).toUpperCase(),
        status: result.status || 'PENDING',
        bodyText: bodyText.trim(),
        lastSyncedAt: now,
      },
    });

    res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
});

router.post('/whatsapp/templates/sync', async (req, res, next) => {
  try {
    const result = await whatsappService.syncTemplatesFromMeta();
    if (!result.ok) {
      throw new ValidationError(result.error || 'Error al sincronizar plantillas');
    }
    const rows = await prisma.whatsAppTemplate.findMany({
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
      select: {
        id: true,
        metaId: true,
        name: true,
        language: true,
        category: true,
        status: true,
        bodyText: true,
        lastSyncedAt: true,
        updatedAt: true,
      },
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
