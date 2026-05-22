'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { normalizeCustomerEmail } = require('./emailNormalize');
const { resolveScheduledFor, evaluateSendWindowForReservation } = require('./scheduling');
const { isOnCooldown, isOptedOut } = require('./eligibility');
const { sendPostVisitFeedbackEmail } = require('../notificationService');

const ADMIN_SEND_OVERRIDES = {
  bypassWindow: true,
  bypassTooEarly: true,
  bypassCooldown: true,
  forceCanSend: true,
  allowResend: true,
};

async function getOrCreateFeedbackSurvey(restaurantId) {
  let survey = await prisma.feedbackSurvey.findUnique({ where: { restaurantId } });
  if (!survey) {
    survey = await prisma.feedbackSurvey.create({ data: { restaurantId } });
  }
  return survey;
}

function getApiBaseUrl() {
  return (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

/**
 * Crea o actualiza request pendiente y envía email si está en ventana.
 * @param {object} params
 * @returns {Promise<{ sent: boolean; skipped: boolean; reason?: string }>}
 */
async function processFeedbackRequest({ reservation, survey, canSend, adminOverrides = null }) {
  const email = normalizeCustomerEmail(reservation.customerEmail);
  if (!email) {
    return { sent: false, skipped: true, reason: 'no_email' };
  }

  const bypassOptOut = adminOverrides?.bypassOptOut;
  const bypassCooldown = adminOverrides?.bypassCooldown;
  const bypassWindow = adminOverrides?.bypassWindow;
  const bypassTooEarly = adminOverrides?.bypassTooEarly;
  const forceCanSend = adminOverrides?.forceCanSend;
  const allowResend = adminOverrides?.allowResend;

  const scheduledFor = resolveScheduledFor(reservation, survey);
  const windowInfo = evaluateSendWindowForReservation(reservation, survey);
  const window = {
    inWindow: windowInfo.inWindow,
    expired: windowInfo.expired,
    tooEarly: windowInfo.tooEarly,
  };

  let request = await prisma.feedbackRequest.findUnique({
    where: { reservationId: reservation.id },
  });

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
    } catch (err) {
      if (err.code === 'P2002') return { sent: false, skipped: true, reason: 'duplicate' };
      throw err;
    }
  }

  if (allowResend && (request.sentAt || ['skipped', 'expired'].includes(request.status))) {
    request = await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: {
        status: 'pending',
        skipReason: null,
        sentAt: null,
        scheduledFor,
      },
    });
  }

  if (request.status === 'completed') {
    return { sent: false, skipped: true, reason: 'completed' };
  }

  if (request.status === 'skipped' && !allowResend) {
    return { sent: false, skipped: true, reason: request.skipReason || request.status };
  }

  if (await isOptedOut(email, reservation.restaurantId) && !bypassOptOut) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'skipped', skipReason: 'opt_out' },
    });
    return { sent: false, skipped: true, reason: 'opt_out' };
  }

  if (
    !bypassCooldown
    && await isOnCooldown(reservation.restaurantId, email, survey.minDaysBetweenFeedbackRequests)
  ) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'skipped', skipReason: 'cooldown' },
    });
    return { sent: false, skipped: true, reason: 'cooldown' };
  }

  if (window.expired && !bypassWindow) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'expired', skipReason: 'window_expired' },
    });
    return { sent: false, skipped: true, reason: 'window_expired' };
  }

  if (window.tooEarly && !bypassTooEarly) {
    return { sent: false, skipped: false, reason: 'too_early' };
  }

  if (!canSend && !forceCanSend) {
    return { sent: false, skipped: true, reason: 'subscription' };
  }

  if (request.sentAt && !allowResend) {
    return { sent: false, skipped: false, reason: 'already_sent' };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: reservation.restaurantId },
    select: { name: true, timezone: true, logoUrl: true, slug: true },
  });

  const clickUrl = `${getApiBaseUrl()}/api/public/feedback/${request.token}/click`;
  const optOutUrl = `${getApiBaseUrl()}/api/public/feedback/${request.token}/opt-out`;

  const subjectVariant = process.env.FEEDBACK_EMAIL_SUBJECT_VARIANT || 'a';
  const ok = await sendPostVisitFeedbackEmail({
    customerEmail: email,
    customerName: reservation.customerName,
    restaurantName: restaurant?.name || 'Restaurante',
    dateTime: reservation.dateTime,
    timezone: restaurant?.timezone,
    clickUrl,
    optOutUrl,
    subjectVariant,
  });

  if (!ok) {
    return { sent: false, skipped: false, reason: 'email_failed' };
  }

  await prisma.feedbackRequest.update({
    where: { id: request.id },
    data: { sentAt: new Date(), status: 'sent' },
  });

  return { sent: true, skipped: false };
}

/**
 * @param {string} token
 * @returns {Promise<{ redirectUrl: string }|null>}
 */
async function recordClickAndGetRedirect(token) {
  const request = await prisma.feedbackRequest.findUnique({
    where: { token },
    select: { id: true, clickedAt: true, status: true },
  });
  if (!request) return null;

  const frontBase = (process.env.FRONTEND_LANDING_PAGE_URL || process.env.FRONTEND_LANDING_PAGE_URL || 'http://localhost:5173').replace(/\/$/, '');
  const redirectUrl = `${frontBase}/feedback/${token}`;

  if (!request.clickedAt) {
    const statusOrder = ['pending', 'sent', 'clicked', 'opened', 'completed'];
    const nextStatus = request.status === 'sent' || request.status === 'pending' ? 'clicked' : request.status;
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: {
        clickedAt: new Date(),
        status: statusOrder.includes(nextStatus) ? nextStatus : request.status,
      },
    });
  }

  return { redirectUrl };
}

/**
 * Envío manual por soporte (panel admin). Omite ventana, cooldown y suscripción.
 * @param {object} options
 * @param {boolean} [options.ignoreOptOut]
 * @param {boolean} [options.resend]
 */
async function adminManualSendByRequestId(restaurantId, requestId, options = {}) {
  const request = await prisma.feedbackRequest.findFirst({
    where: { id: requestId, restaurantId },
    include: { reservation: true },
  });
  if (!request) throw new NotFoundError('Solicitud de encuesta no encontrada');
  if (!request.reservation) throw new ValidationError('Reserva asociada no encontrada');

  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  if (!survey.enabled) throw new ValidationError('Las encuestas post-visita están desactivadas para este local');

  return processFeedbackRequest({
    reservation: request.reservation,
    survey,
    canSend: true,
    adminOverrides: {
      ...ADMIN_SEND_OVERRIDES,
      bypassOptOut: true,
      allowResend: true,
    },
  });
}

async function adminManualSendByReservationId(restaurantId, reservationId, options = {}) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, restaurantId },
  });
  if (!reservation) throw new NotFoundError('Reserva no encontrada');

  const survey = await getOrCreateFeedbackSurvey(restaurantId);
  if (!survey.enabled) throw new ValidationError('Las encuestas post-visita están desactivadas para este local');

  return processFeedbackRequest({
    reservation,
    survey,
    canSend: true,
    adminOverrides: {
      ...ADMIN_SEND_OVERRIDES,
      bypassOptOut: true,
      allowResend: true,
    },
  });
}

module.exports = {
  ADMIN_SEND_OVERRIDES,
  processFeedbackRequest,
  recordClickAndGetRedirect,
  getApiBaseUrl,
  adminManualSendByRequestId,
  adminManualSendByReservationId,
  getOrCreateFeedbackSurvey,
};
