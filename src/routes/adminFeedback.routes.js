'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { validateSendDelayMinutes } = require('../lib/feedbackDevLimits');
const {
  getRestaurantSummary,
  getRestaurantInsights,
  adminManualSendByRequestId,
  adminManualSendByReservationId,
  getOrCreateFeedbackSurvey,
  listFeedbackOutreach,
  ensureFeedbackRequestForReservation,
  syncRestaurantFeedbackQueue,
} = require('../services/feedbackEngine');

const router = express.Router({ mergeParams: true });

function restaurantIdFromParams(req) {
  return req.params.id;
}

function parsePeriod(req) {
  const days = parseInt(req.query.days || '30', 10);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - days * 24 * 60 * 60_000);
  return { from, to };
}

async function assertRestaurantExists(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true },
  });
  if (!restaurant) throw new NotFoundError('Restaurante no encontrado');
  return restaurant;
}

router.use(async (req, res, next) => {
  try {
    await assertRestaurantExists(restaurantIdFromParams(req));
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const survey = await getOrCreateFeedbackSurvey(restaurantIdFromParams(req));
    res.json(survey);
  } catch (err) {
    next(err);
  }
});

router.patch('/settings', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const body = req.body || {};
    const existing = await prisma.feedbackSurvey.findUnique({ where: { restaurantId } });
    const allowed = [
      'enabled', 'sendDelayMinutes', 'sendWindowMinutes', 'minDaysBetweenFeedbackRequests',
      'eligibilityMode', 'excludeWalkIns', 'minPartySize', 'maxPartySize',
      'googleReviewUrl', 'instagramUrl', 'recoveryThreshold', 'notifyOnRecovery', 'notifyEmail',
      'brandingJson',
    ];
    const data = {};
    for (const key of allowed) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    if (data.eligibilityMode && !['confirmed_past_end', 'completed_only'].includes(data.eligibilityMode)) {
      throw new ValidationError('Modo de elegibilidad no válido');
    }

    const effectiveMode = data.eligibilityMode || existing?.eligibilityMode || 'confirmed_past_end';
    if (effectiveMode === 'completed_only') {
      delete data.sendDelayMinutes;
    } else if (data.sendDelayMinutes !== undefined) {
      const delayCheck = validateSendDelayMinutes(data.sendDelayMinutes, {
        admin: true,
        eligibilityMode: effectiveMode,
      });
      if (!delayCheck.ok) {
        throw new ValidationError(delayCheck.message);
      }
      if (delayCheck.value !== undefined) {
        data.sendDelayMinutes = delayCheck.value;
      }
    }

    const survey = await prisma.feedbackSurvey.upsert({
      where: { restaurantId },
      create: { restaurantId, ...data },
      update: data,
    });
    res.json(survey);
  } catch (err) {
    next(err);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = parsePeriod(req);
    const summary = await getRestaurantSummary(restaurantIdFromParams(req), from, to);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get('/insights', async (req, res, next) => {
  try {
    const { from, to } = parsePeriod(req);
    const insights = await getRestaurantInsights(restaurantIdFromParams(req), from, to);
    res.json(insights);
  } catch (err) {
    next(err);
  }
});

router.get('/responses', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const { page, limit, skip } = parsePagination(req);
    const where = { feedbackRequest: { restaurantId } };
    if (req.query.minScore) where.overallScore = { gte: parseInt(req.query.minScore, 10) };
    if (req.query.maxScore) where.overallScore = { ...where.overallScore, lte: parseInt(req.query.maxScore, 10) };

    const [items, total] = await Promise.all([
      prisma.feedbackResponse.findMany({
        where,
        skip,
        take: limit,
        orderBy: { respondedAt: 'desc' },
        include: {
          feedbackRequest: {
            select: {
              reservation: { select: { customerName: true, customerEmail: true, dateTime: true } },
            },
          },
        },
      }),
      prisma.feedbackResponse.count({ where }),
    ]);

    res.json(paginatedResponse(items, total, page, limit));
  } catch (err) {
    next(err);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const status = req.query.status || 'open';
    const { ALERT_DETAIL_INCLUDE, formatAlertForApi } = require('../services/feedbackEngine/feedbackAlertFormat');
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const alerts = await prisma.feedbackAlert.findMany({
      where: {
        restaurantId,
        ...(status !== 'all' ? { status } : {}),
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: ALERT_DETAIL_INCLUDE,
    });
    res.json(alerts.map((a) => formatAlertForApi(a, restaurant?.timezone)));
  } catch (err) {
    next(err);
  }
});

router.patch('/alerts/:alertId', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const { status } = req.body;
    if (!['acknowledged', 'resolved', 'open'].includes(status)) {
      throw new ValidationError('Estado no válido');
    }
    const alert = await prisma.feedbackAlert.findFirst({
      where: { id: req.params.alertId, restaurantId },
    });
    if (!alert) throw new NotFoundError('Alerta no encontrada');

    const updated = await prisma.feedbackAlert.update({
      where: { id: alert.id },
      data: {
        status,
        resolvedAt: status === 'resolved' ? new Date() : null,
        resolvedByUserId: status === 'resolved' ? req.user?.id : null,
      },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/outreach', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const { page, limit } = parsePagination(req);
    const result = await listFeedbackOutreach(restaurantId, { page, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/requests', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const { page, limit } = parsePagination(req);
    const result = await listFeedbackOutreach(restaurantId, { page, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sync', async (req, res, next) => {
  try {
    const result = await syncRestaurantFeedbackQueue(restaurantIdFromParams(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/reservations/:reservationId/enqueue', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const reservation = await prisma.reservation.findFirst({
      where: { id: req.params.reservationId, restaurantId },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    const result = await ensureFeedbackRequestForReservation(reservation, {
      trySendNow: !!req.body?.trySendNow,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/requests/:requestId/send', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const result = await adminManualSendByRequestId(restaurantId, req.params.requestId, {
      ignoreOptOut: !!req.body?.ignoreOptOut,
      resend: req.body?.resend !== false,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/reservations/:reservationId/send', async (req, res, next) => {
  try {
    const restaurantId = restaurantIdFromParams(req);
    const result = await adminManualSendByReservationId(restaurantId, req.params.reservationId, {
      ignoreOptOut: !!req.body?.ignoreOptOut,
      resend: req.body?.resend !== false,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
