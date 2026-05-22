'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_FEEDBACK_VIEW, ROLES_FEEDBACK_SETTINGS } = require('../auth/roles');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const {
  getPublicFeedbackMeta,
  markOpened,
  submitFeedbackResponse,
  recordClickAndGetRedirect,
  getRestaurantSummary,
  getRestaurantInsights,
} = require('../services/feedbackEngine');
const { hashEmail } = require('../services/feedbackEngine/emailNormalize');

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const publicRouter = express.Router({ mergeParams: true });
publicRouter.use(publicLimiter);

publicRouter.get('/:token/click', async (req, res, next) => {
  try {
    const result = await recordClickAndGetRedirect(req.params.token);
    if (!result) throw new NotFoundError('Encuesta no encontrada');
    res.redirect(302, result.redirectUrl);
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/:token', async (req, res, next) => {
  try {
    const meta = await getPublicFeedbackMeta(req.params.token);
    res.json(meta);
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/:token/open', async (req, res, next) => {
  try {
    await markOpened(req.params.token);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/:token/submit', async (req, res, next) => {
  try {
    const result = await submitFeedbackResponse(req.params.token, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/:token/opt-out', async (req, res, next) => {
  try {
    const request = await prisma.feedbackRequest.findUnique({
      where: { token: req.params.token },
      include: { reservation: { select: { customerEmail: true } } },
    });
    if (!request) throw new NotFoundError('Encuesta no encontrada');

    const email = request.reservation?.customerEmail;
    if (email) {
      const h = hashEmail(email);
      const existing = await prisma.customerFeedbackPreference.findFirst({
        where: { emailHash: h, restaurantId: request.restaurantId },
      });
      if (existing) {
        await prisma.customerFeedbackPreference.update({
          where: { id: existing.id },
          data: { optedOutAt: new Date() },
        });
      } else {
        await prisma.customerFeedbackPreference.create({
          data: { emailHash: h, restaurantId: request.restaurantId },
        });
      }
    }

    const frontBase = (process.env.FRONTEND_LANDING_PAGE_URL || 'http://localhost:5173').replace(/\/$/, '');
    res.redirect(302, `${frontBase}/feedback/${req.params.token}?optout=1`);
  } catch (err) {
    next(err);
  }
});

const restaurantRouter = express.Router({ mergeParams: true });
restaurantRouter.use(authenticateToken);
restaurantRouter.use(authorizeRestaurant);
restaurantRouter.use(authenticateRestaurantRoles(ROLES_FEEDBACK_VIEW));

function parsePeriod(req) {
  const days = parseInt(req.query.days || '30', 10);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - days * 24 * 60 * 60_000);
  return { from, to };
}

restaurantRouter.get('/settings', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    let survey = await prisma.feedbackSurvey.findUnique({ where: { restaurantId } });
    if (!survey) {
      survey = await prisma.feedbackSurvey.create({
        data: { restaurantId },
      });
    }
    res.json(survey);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.patch('/settings', authenticateRestaurantRoles(ROLES_FEEDBACK_SETTINGS), async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const body = req.body || {};
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

restaurantRouter.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = parsePeriod(req);
    const summary = await getRestaurantSummary(req.params.restaurantId, from, to);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.get('/insights', async (req, res, next) => {
  try {
    const { from, to } = parsePeriod(req);
    const insights = await getRestaurantInsights(req.params.restaurantId, from, to);
    res.json(insights);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.get('/responses', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const { page, limit, skip } = parsePagination(req);
    const where = {
      feedbackRequest: { restaurantId },
    };
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

restaurantRouter.get('/alerts', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const status = req.query.status || 'open';
    const alerts = await prisma.feedbackAlert.findMany({
      where: {
        restaurantId,
        ...(status !== 'all' ? { status } : {}),
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        feedbackResponse: {
          select: {
            overallScore: true,
            comment: true,
            feedbackRequest: {
              select: { reservation: { select: { customerName: true } } },
            },
          },
        },
      },
    });
    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.patch('/alerts/:alertId', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['acknowledged', 'resolved', 'open'].includes(status)) {
      throw new ValidationError('Estado no válido');
    }
    const alert = await prisma.feedbackAlert.findFirst({
      where: { id: req.params.alertId, restaurantId: req.params.restaurantId },
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

module.exports = { publicRouter, restaurantRouter };
