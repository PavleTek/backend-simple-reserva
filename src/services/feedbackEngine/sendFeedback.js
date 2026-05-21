'use strict';

const prisma = require('../../lib/prisma');
const { normalizeCustomerEmail } = require('./emailNormalize');
const { computeVisitEnd, computeScheduledFor, evaluateSendWindow } = require('./scheduling');
const { isOnCooldown, isOptedOut } = require('./eligibility');
const { sendPostVisitFeedbackEmail } = require('../notificationService');

function getApiBaseUrl() {
  return (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

/**
 * Crea o actualiza request pendiente y envía email si está en ventana.
 * @param {object} params
 * @returns {Promise<{ sent: boolean; skipped: boolean; reason?: string }>}
 */
async function processFeedbackRequest({ reservation, survey, canSend }) {
  const email = normalizeCustomerEmail(reservation.customerEmail);
  const visitEnd = computeVisitEnd(reservation.dateTime, reservation.durationMinutes);
  const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);
  const window = evaluateSendWindow(scheduledFor, survey.sendWindowMinutes);

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

  if (request.status === 'completed' || request.status === 'skipped') {
    return { sent: false, skipped: true, reason: request.skipReason || request.status };
  }

  if (await isOptedOut(email, reservation.restaurantId)) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'skipped', skipReason: 'opt_out' },
    });
    return { sent: false, skipped: true, reason: 'opt_out' };
  }

  if (await isOnCooldown(reservation.restaurantId, email, survey.minDaysBetweenFeedbackRequests)) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'skipped', skipReason: 'cooldown' },
    });
    return { sent: false, skipped: true, reason: 'cooldown' };
  }

  if (window.expired) {
    await prisma.feedbackRequest.update({
      where: { id: request.id },
      data: { status: 'expired', skipReason: 'window_expired' },
    });
    return { sent: false, skipped: true, reason: 'window_expired' };
  }

  if (window.tooEarly) {
    return { sent: false, skipped: false, reason: 'too_early' };
  }

  if (!canSend) {
    return { sent: false, skipped: true, reason: 'subscription' };
  }

  if (request.sentAt) {
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

module.exports = { processFeedbackRequest, recordClickAndGetRedirect, getApiBaseUrl };
