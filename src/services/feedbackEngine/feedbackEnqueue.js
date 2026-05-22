'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { normalizeCustomerEmail } = require('./emailNormalize');
const { checkReservationEligibility } = require('./eligibility');
const { computeVisitEnd, computeScheduledFor, evaluateSendWindow } = require('./scheduling');
const {
  processFeedbackRequest,
  getOrCreateFeedbackSurvey,
} = require('./sendFeedback');
const { canSendFeedback } = require('../subscriptionService');

const OUTREACH_LOOKBACK_DAYS = 90;

/**
 * Crea o devuelve FeedbackRequest pendiente para una reserva elegible.
 * @param {object} reservation - fila Reservation
 * @param {object} [options]
 * @param {boolean} [options.trySendNow]
 * @returns {Promise<{ request: object|null; created: boolean; eligible: boolean; reason?: string; sendResult?: object }>}
 */
async function ensureFeedbackRequestForReservation(reservation, options = {}) {
  const survey = await getOrCreateFeedbackSurvey(reservation.restaurantId);
  const { eligible, skipReason } = checkReservationEligibility(reservation, survey);

  if (!eligible) {
    return { request: null, created: false, eligible: false, reason: skipReason };
  }

  const email = normalizeCustomerEmail(reservation.customerEmail);
  const visitEnd = computeVisitEnd(reservation.dateTime, reservation.durationMinutes);
  const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);

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
  }

  let sendResult;
  if (options.trySendNow && request && !request.sentAt) {
    const canSend = await canSendFeedback(reservation.restaurantId);
    sendResult = await processFeedbackRequest({
      reservation,
      survey,
      canSend,
    });
  }

  return { request, created, eligible: true, sendResult };
}

/**
 * Tras cambio de estado de reserva (p. ej. completada).
 */
async function syncFeedbackOnReservationStatusChange(reservation, newStatus) {
  if (newStatus !== 'completed' && newStatus !== 'confirmed') return;

  try {
    const survey = await getOrCreateFeedbackSurvey(reservation.restaurantId);
    if (!survey.enabled) return;

    const full = await prisma.reservation.findUnique({
      where: { id: reservation.id },
    });
    if (!full) return;

    if (newStatus === 'completed') {
      await ensureFeedbackRequestForReservation(full, { trySendNow: true });
      return;
    }

    if (newStatus === 'confirmed' && survey.eligibilityMode !== 'completed_only') {
      const { eligible } = checkReservationEligibility(full, survey);
      if (eligible) {
        await ensureFeedbackRequestForReservation(full, { trySendNow: true });
      }
    }
  } catch (err) {
    logger.error(
      { err, reservationId: reservation.id, newStatus },
      '[FeedbackEnqueue] sync on status change failed',
    );
  }
}

/**
 * Lista unificada para admin: solicitudes existentes + reservas elegibles sin solicitud.
 */
async function listFeedbackOutreach(restaurantId, { page = 1, limit = 50 } = {}) {
  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  const now = new Date();
  const lookback = new Date(now.getTime() - OUTREACH_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const skip = (page - 1) * limit;

  if (!survey.enabled) {
    return {
      survey: { enabled: false, eligibilityMode: survey.eligibilityMode },
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
    include: {
      feedbackRequest: true,
    },
  });

  const rows = [];
  for (const r of reservations) {
    const { eligible, skipReason } = checkReservationEligibility(r, survey, now);
    const req = r.feedbackRequest;
    const visitEnd = computeVisitEnd(r.dateTime, r.durationMinutes);
    const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);
    const window = evaluateSendWindow(scheduledFor, survey.sendWindowMinutes, now);

    rows.push({
      reservationId: r.id,
      requestId: req?.id ?? null,
      customerName: r.customerName,
      customerEmail: r.customerEmail,
      dateTime: r.dateTime,
      reservationStatus: r.status,
      eligible,
      eligibilityReason: eligible ? null : skipReason,
      scheduledFor: req?.scheduledFor ?? scheduledFor,
      sentAt: req?.sentAt ?? null,
      requestStatus: req?.status ?? (eligible ? 'sin_solicitud' : 'no_elegible'),
      skipReason: req?.skipReason ?? null,
      emailSent: !!req?.sentAt,
      inSendWindow: window.inWindow,
      sendWindowState: window.expired ? 'expired' : window.tooEarly ? 'too_early' : 'in_window',
      canSendManual:
        eligible
        && !!normalizeCustomerEmail(r.customerEmail)
        && (!req || !['completed'].includes(req.status)),
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

/**
 * Crea solicitudes pendientes para reservas elegibles recientes (backfill / soporte).
 */
async function syncRestaurantFeedbackQueue(restaurantId) {
  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  if (!survey.enabled) {
    return { enqueued: 0, total: 0, enabled: false };
  }

  const now = new Date();
  const lookback = new Date(now.getTime() - OUTREACH_LOOKBACK_DAYS * 24 * 60 * 60_000);
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
    });
    if (created && eligible) enqueued += 1;
  }

  return { enqueued, total: reservations.length, enabled: true };
}

module.exports = {
  ensureFeedbackRequestForReservation,
  syncFeedbackOnReservationStatusChange,
  listFeedbackOutreach,
  syncRestaurantFeedbackQueue,
};
