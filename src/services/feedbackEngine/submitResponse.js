'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { isTokenExpired } = require('./scheduling');
const { inferSentiment } = require('./sentiment');
const { processRecovery } = require('./recovery');
const { getEffectiveTimezone } = require('../../utils/timezone');
const { getDayOfWeekInTimezone } = require('../../utils/timezone');

const TTL_DAYS = parseInt(process.env.FEEDBACK_TOKEN_TTL_DAYS || '14', 10);

/**
 * @param {string} token
 * @returns {Promise<object>}
 */
async function getPublicFeedbackMeta(token) {
  const request = await prisma.feedbackRequest.findUnique({
    where: { token },
    include: {
      response: { select: { id: true } },
      reservation: {
        select: {
          customerName: true,
          dateTime: true,
          partySize: true,
          restaurant: {
            select: {
              name: true,
              slug: true,
              logoUrl: true,
              googlePlaceId: true,
              timezone: true,
            },
          },
        },
      },
    },
  });

  if (!request) throw new NotFoundError('Encuesta no encontrada');

  const expired =
    request.sentAt && isTokenExpired(request.sentAt, TTL_DAYS);

  const survey = await prisma.feedbackSurvey.findUnique({
    where: { restaurantId: request.restaurantId },
  });

  let googleReviewUrl = survey?.googleReviewUrl || null;
  const placeId = request.reservation?.restaurant?.googlePlaceId;
  if (!googleReviewUrl && placeId) {
    googleReviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;
  }

  return {
    restaurantName: request.reservation?.restaurant?.name,
    restaurantSlug: request.reservation?.restaurant?.slug,
    logoUrl: request.reservation?.restaurant?.logoUrl,
    visitDateTime: request.reservation?.dateTime,
    customerName: request.reservation?.customerName,
    partySize: request.reservation?.partySize,
    alreadyCompleted: !!request.response || request.status === 'completed',
    expired: expired || request.status === 'expired',
    googleReviewUrl,
    instagramUrl: survey?.instagramUrl || null,
    timezone: request.reservation?.restaurant?.timezone,
  };
}

/**
 * @param {string} token
 */
async function markOpened(token) {
  const request = await prisma.feedbackRequest.findUnique({ where: { token } });
  if (!request || request.openedAt) return;

  const status =
    request.status === 'sent' || request.status === 'clicked' ? 'opened' : request.status;

  await prisma.feedbackRequest.update({
    where: { id: request.id },
    data: { openedAt: new Date(), status },
  });
}

/**
 * @param {string} token
 * @param {object} body
 */
async function submitFeedbackResponse(token, body) {
  const request = await prisma.feedbackRequest.findUnique({
    where: { token },
    include: {
      response: true,
      reservation: {
        include: {
          restaurant: {
            select: {
              id: true,
              name: true,
              email: true,
              organizationId: true,
              address: true,
              shortAddress: true,
              timezone: true,
            },
          },
          table: { select: { id: true, zoneId: true } },
        },
      },
    },
  });

  if (!request) throw new NotFoundError('Encuesta no encontrada');
  if (request.response) throw new ValidationError('Ya respondiste esta encuesta');
  if (request.status === 'expired') throw new ValidationError('Esta encuesta ya cerró');
  if (request.sentAt && isTokenExpired(request.sentAt, TTL_DAYS)) {
    throw new ValidationError('Esta encuesta ya cerró');
  }

  const overallScore = Number(body.overallScore);
  if (!Number.isInteger(overallScore) || overallScore < 1 || overallScore > 5) {
    throw new ValidationError('Puntuación general inválida (1–5)');
  }

  const clamp = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  };

  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : null;
  const reservation = request.reservation;
  const tz = getEffectiveTimezone(reservation.restaurant);
  const dt = new Date(reservation.dateTime);
  const hourBucket = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(dt),
    10
  );

  const cityKey = deriveCityKey(reservation.restaurant);

  const survey = await prisma.feedbackSurvey.findUnique({
    where: { restaurantId: request.restaurantId },
  });

  const response = await prisma.feedbackResponse.create({
    data: {
      feedbackRequestId: request.id,
      overallScore,
      serviceScore: clamp(body.serviceScore),
      foodScore: clamp(body.foodScore),
      atmosphereScore: clamp(body.atmosphereScore),
      reservationScore: clamp(body.reservationScore),
      comment: comment || null,
      sentiment: inferSentiment(overallScore, comment),
      recoveryContactRequested: !!body.recoveryContactRequested,
      recoveryContactEmail: body.recoveryContactEmail || null,
      recoveryContactPhone: body.recoveryContactPhone || null,
      partySize: reservation.partySize,
      dateTime: reservation.dateTime,
      dayOfWeek: getDayOfWeekInTimezone(reservation.dateTime, tz),
      hourBucket,
      tableId: reservation.tableId,
      zoneId: reservation.table?.zoneId || null,
      organizationId: reservation.restaurant.organizationId,
      cityKey,
    },
  });

  const recovery = await processRecovery({
    restaurantId: request.restaurantId,
    feedbackResponseId: response.id,
    overallScore,
    recoveryThreshold: survey?.recoveryThreshold,
    categoryScores: {
      serviceScore: response.serviceScore,
      foodScore: response.foodScore,
      atmosphereScore: response.atmosphereScore,
      reservationScore: response.reservationScore,
    },
    comment,
    customerName: reservation.customerName,
    survey,
    restaurant: reservation.restaurant,
  });

  if (recovery.recoveryTriggered) {
    await prisma.feedbackResponse.update({
      where: { id: response.id },
      data: { recoveryTriggered: true },
    });
  }

  await prisma.feedbackRequest.update({
    where: { id: request.id },
    data: { completedAt: new Date(), status: 'completed' },
  });

  return { success: true, recoveryTriggered: recovery.recoveryTriggered };
}

/**
 * @param {{ address?: string|null; shortAddress?: string|null }} restaurant
 */
function deriveCityKey(restaurant) {
  const raw = restaurant?.shortAddress || restaurant?.address || '';
  if (!raw) return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2].toLowerCase();
  return parts[0]?.toLowerCase() || null;
}

module.exports = {
  getPublicFeedbackMeta,
  markOpened,
  submitFeedbackResponse,
};
