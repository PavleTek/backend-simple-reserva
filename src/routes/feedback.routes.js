'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_FEEDBACK_VIEW, ROLES_FEEDBACK_SETTINGS } = require('../auth/roles');
const { validateSendDelayMinutes } = require('../lib/feedbackDevLimits');
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
const { requirePostVisitFeedbackPlan } = require('../middleware/requirePostVisitFeedbackPlan');
const {
  listFeedbackOutreach,
  syncRestaurantFeedbackQueue,
} = require('../services/feedbackEngine/feedbackEnqueue');

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
restaurantRouter.use(requirePostVisitFeedbackPlan);

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
      const delayCheck = validateSendDelayMinutes(data.sendDelayMinutes, { eligibilityMode: effectiveMode });
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
          alerts: {
            where: { status: 'resolved' },
            orderBy: { resolvedAt: 'desc' },
            take: 1,
            select: {
              status: true,
              resolutionNote: true,
              resolvedAt: true,
              resolvedByDisplayName: true,
            },
          },
        },
      }),
      prisma.feedbackResponse.count({ where }),
    ]);

    const { formatRecoveryResolution } = require('../services/feedbackEngine/feedbackAlertResolve');
    const mapped = items.map((row) => {
      const alert = row.alerts?.[0];
      const { alerts: _a, ...rest } = row;
      return {
        ...rest,
        recoveryResolution: formatRecoveryResolution(alert),
      };
    });

    res.json(paginatedResponse(mapped, total, page, limit));
  } catch (err) {
    next(err);
  }
});

restaurantRouter.get('/alerts', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
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

restaurantRouter.get('/outreach', async (req, res, next) => {
  try {
    const { page, limit } = parsePagination(req);
    const result = await listFeedbackOutreach(req.params.restaurantId, { page, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.post('/sync', authenticateRestaurantRoles(ROLES_FEEDBACK_SETTINGS), async (req, res, next) => {
  try {
    const result = await syncRestaurantFeedbackQueue(req.params.restaurantId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

restaurantRouter.patch('/alerts/:alertId', async (req, res, next) => {
  try {
    const { status, resolutionNote } = req.body;
    if (status !== 'resolved') {
      throw new ValidationError('Solo puedes marcar la alerta como resuelta, con una nota interna.');
    }
    const { resolveFeedbackAlert } = require('../services/feedbackEngine/feedbackAlertResolve');
    const updated = await resolveFeedbackAlert({
      alertId: req.params.alertId,
      restaurantId: req.params.restaurantId,
      user: req.user,
      resolutionNote,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = { publicRouter, restaurantRouter };
