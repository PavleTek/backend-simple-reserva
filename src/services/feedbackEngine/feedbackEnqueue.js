'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { normalizeCustomerEmail } = require('./emailNormalize');
const { checkReservationEligibility } = require('./eligibility');
const {
  resolveScheduledFor,
  evaluateSendWindowForReservation,
  shouldAutoSendOnStatusChange,
  isCompletedOnlyMode,
} = require('./scheduling');
const {
  processFeedbackRequest,
  getOrCreateFeedbackSurvey,
} = require('./sendFeedback');
const { canSendFeedback } = require('../subscriptionService');
const planService = require('../planService');

const OUTREACH_LOOKBACK_DAYS = 90;

const COMPLETED_MARK_SEND_OVERRIDES = {
  bypassTooEarly: true,
  bypassWindow: true,
};

function resolveEligibility(reservation, survey, now) {
  if (isCompletedOnlyMode(survey) && reservation.status === 'completed') {
    const base = checkReservationEligibility(reservation, survey, now);
    if (!base.eligible && base.skipReason !== 'not_completed') {
      return base;
    }
    return { eligible: true, skipReason: null };
  }
  return checkReservationEligibility(reservation, survey, now);
}

/**
 * @param {object} reservation
 * @param {object} [options]
 * @param {boolean} [options.trySendNow]
 * @param {boolean} [options.skipPlanCheck]
 */
async function ensureFeedbackRequestForReservation(reservation, options = {}) {
  if (!options.skipPlanCheck) {
    const planOk = await planService.canUsePostVisitFeedback(reservation.restaurantId);
    if (!planOk) {
      return { request: null, created: false, eligible: false, reason: 'plan' };
    }
  }

  const survey = await getOrCreateFeedbackSurvey(reservation.restaurantId);
  const { eligible, skipReason } = resolveEligibility(reservation, survey);

  if (!eligible) {
    return { request: null, created: false, eligible: false, reason: skipReason };
  }

  const email = normalizeCustomerEmail(reservation.customerEmail);
  const scheduledFor = resolveScheduledFor(reservation, survey);

  let request = await prisma.feedbackRequest.findUnique({
    where: { reservationId: reservation.id },
  });

  let created = false;
  if (!request) {
    try {
      request = await prisma.feedbackRequest.create({
        data: {
          reservationId: reservation.id,
          restaurantId: reservation.restaurantId,
          customerEmailNormalized: email,
          scheduledFor,
          status: 'pending',
        },
      });
      created = true;
    } catch (err) {
      if (err.code === 'P2002') {
        request = await prisma.feedbackRequest.findUnique({
          where: { reservationId: reservation.id },
        });
      } else {
        throw err;
      }
    }
  } else if (isCompletedOnlyMode(survey) && reservation.status === 'completed' && !request.sentAt) {
    request = await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { scheduledFor, status: 'pending', skipReason: null },
    });
  }

  let sendResult;
  const trySend = options.trySendNow && request && !request.sentAt;
  if (trySend) {
    const canSend = await canSendFeedback(reservation.restaurantId);
    const useInstantOverrides =
      isCompletedOnlyMode(survey) && reservation.status === 'completed';
    sendResult = await processFeedbackRequest({
      reservation,
      survey,
      canSend,
      adminOverrides: useInstantOverrides ? COMPLETED_MARK_SEND_OVERRIDES : null,
    });
    if (!sendResult.sent && sendResult.reason) {
      logger.info(
        {
          reservationId: reservation.id,
          restaurantId: reservation.restaurantId,
          reason: sendResult.reason,
        },
        '[FeedbackEnqueue] send on enqueue skipped',
      );
    }
  }

  return { request, created, eligible: true, sendResult };
}

async function syncFeedbackOnReservationStatusChange(reservation, newStatus) {
  if (newStatus !== 'completed' && newStatus !== 'confirmed') return;

  try {
    const planOk = await planService.canUsePostVisitFeedback(reservation.restaurantId);
    if (!planOk) return;

    const survey = await getOrCreateFeedbackSurvey(reservation.restaurantId);
    if (!survey.enabled) return;

    const full = await prisma.reservation.findUnique({
      where: { id: reservation.id },
    });
    if (!full) return;

    const trySendNow = shouldAutoSendOnStatusChange(full, survey);
    await ensureFeedbackRequestForReservation(full, { trySendNow, skipPlanCheck: true });
  } catch (err) {
    logger.error(
      { err, reservationId: reservation.id, newStatus },
      '[FeedbackEnqueue] sync on status change failed',
    );
  }
}

async function listFeedbackOutreach(restaurantId, { page = 1, limit = 50 } = {}) {
  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  const now = new Date();
  const lookback = new Date(now.getTime() - OUTREACH_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const skip = (page - 1) * limit;

  const planOk = await planService.canUsePostVisitFeedback(restaurantId);

  if (!survey.enabled || !planOk) {
    return {
      survey: {
        enabled: survey.enabled,
        eligibilityMode: survey.eligibilityMode,
        sendDelayMinutes: survey.sendDelayMinutes,
        planAllowsFeedback: planOk,
      },
      items: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }

  const statusFilter =
    survey.eligibilityMode === 'completed_only'
      ? ['completed']
      : ['confirmed', 'completed'];

  const reservations = await prisma.reservation.findMany({
    where: {
      restaurantId,
      status: { in: statusFilter },
      customerEmail: { not: null },
      dateTime: { gte: lookback },
    },
    orderBy: { dateTime: 'desc' },
    include: { feedbackRequest: true },
  });

  const rows = [];
  for (const r of reservations) {
    const { eligible, skipReason } = resolveEligibility(r, survey, now);
    const req = r.feedbackRequest;
    const windowInfo = evaluateSendWindowForReservation(r, survey, now);
    const scheduledFor = req?.scheduledFor ?? resolveScheduledFor(r, survey);

    const surveyAnswered = req?.status === 'completed';

    rows.push({
      reservationId: r.id,
      requestId: req?.id ?? null,
      customerName: r.customerName,
      customerEmail: r.customerEmail,
      dateTime: r.dateTime,
      reservationStatus: r.status,
      eligible,
      eligibilityReason: eligible ? null : skipReason,
      scheduledFor,
      sentAt: req?.sentAt ?? null,
      requestStatus: req?.status ?? (eligible ? 'sin_solicitud' : 'no_elegible'),
      skipReason: req?.skipReason ?? null,
      emailSent: !!req?.sentAt,
      inSendWindow: windowInfo.inWindow,
      sendWindowState: windowInfo.label,
      canSendManual:
        eligible
        && !!normalizeCustomerEmail(r.customerEmail)
        && !surveyAnswered,
    });
  }

  const sorted = rows.sort((a, b) => {
    const aPending = !a.emailSent && a.eligible ? 0 : 1;
    const bPending = !b.emailSent && b.eligible ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime();
  });

  const total = sorted.length;
  const items = sorted.slice(skip, skip + limit);

  return {
    survey: {
      enabled: survey.enabled,
      eligibilityMode: survey.eligibilityMode,
      sendDelayMinutes: survey.sendDelayMinutes,
      planAllowsFeedback: planOk,
    },
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
  };
}

async function syncRestaurantFeedbackQueue(restaurantId) {
  const planOk = await planService.canUsePostVisitFeedback(restaurantId);
  if (!planOk) {
    return { enqueued: 0, total: 0, enabled: false, planAllowsFeedback: false };
  }

  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  if (!survey.enabled) {
    return { enqueued: 0, total: 0, enabled: false, planAllowsFeedback: true };
  }

  const lookback = new Date(Date.now() - OUTREACH_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const statusFilter =
    survey.eligibilityMode === 'completed_only'
      ? ['completed']
      : ['confirmed', 'completed'];

  const reservations = await prisma.reservation.findMany({
    where: {
      restaurantId,
      status: { in: statusFilter },
      customerEmail: { not: null },
      dateTime: { gte: lookback },
      feedbackRequest: null,
    },
    orderBy: { dateTime: 'desc' },
    take: 500,
  });

  let enqueued = 0;
  for (const r of reservations) {
    const { created, eligible } = await ensureFeedbackRequestForReservation(r, {
      trySendNow: false,
      skipPlanCheck: true,
    });
    if (created && eligible) enqueued += 1;
  }

  return { enqueued, total: reservations.length, enabled: true, planAllowsFeedback: true };
}

/**
 * Resumen por organización (admin).
 */
async function getOrganizationFeedbackOverview(organizationId) {
  const restaurants = await prisma.restaurant.findMany({
    where: { organizationId, isDeleted: false },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  });

  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const items = [];

  for (const r of restaurants) {
    const planOk = await planService.canUsePostVisitFeedback(r.id);
    const survey = await prisma.feedbackSurvey.findUnique({ where: { restaurantId: r.id } });

    const [sent30d, pendingCount, openAlerts] = await Promise.all([
      prisma.feedbackRequest.count({
        where: { restaurantId: r.id, sentAt: { gte: since } },
      }),
      prisma.feedbackRequest.count({
        where: { restaurantId: r.id, sentAt: null, status: 'pending' },
      }),
      prisma.feedbackAlert.count({
        where: { restaurantId: r.id, status: 'open', type: 'recovery' },
      }),
    ]);

    items.push({
      restaurantId: r.id,
      restaurantName: r.name,
      slug: r.slug,
      planAllowsFeedback: planOk,
      surveyEnabled: !!survey?.enabled,
      eligibilityMode: survey?.eligibilityMode ?? 'confirmed_past_end',
      sentLast30Days: sent30d,
      pendingSendCount: pendingCount,
      openRecoveryAlerts: openAlerts,
    });
  }

  return { items };
}

module.exports = {
  ensureFeedbackRequestForReservation,
  syncFeedbackOnReservationStatusChange,
  listFeedbackOutreach,
  syncRestaurantFeedbackQueue,
  getOrganizationFeedbackOverview,
};
