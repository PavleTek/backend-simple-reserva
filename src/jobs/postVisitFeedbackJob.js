'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { canSendFeedback } = require('../services/subscriptionService');
const {
  checkReservationEligibility,
  computeVisitEnd,
  computeScheduledFor,
  evaluateSendWindow,
} = require('../services/feedbackEngine');
const { processFeedbackRequest } = require('../services/feedbackEngine/sendFeedback');
const { ensureFeedbackRequestForReservation } = require('../services/feedbackEngine/feedbackEnqueue');

const BATCH_SIZE = 200;

async function findCandidateReservations() {
  const now = new Date();
  const surveys = await prisma.feedbackSurvey.findMany({
    where: { enabled: true },
    select: { restaurantId: true, sendDelayMinutes: true, sendWindowMinutes: true, eligibilityMode: true, excludeWalkIns: true, minPartySize: true, maxPartySize: true, minDaysBetweenFeedbackRequests: true },
  });

  if (surveys.length === 0) {
    return { candidates: [], surveyByRestaurant: new Map(), restaurantIds: [] };
  }

  const surveyByRestaurant = new Map(surveys.map((s) => [s.restaurantId, s]));
  const restaurantIds = surveys.map((s) => s.restaurantId);

  const reservations = await prisma.reservation.findMany({
    where: {
      restaurantId: { in: restaurantIds },
      status: { in: ['confirmed', 'completed'] },
      feedbackRequest: null,
      customerEmail: { not: null },
    },
    take: BATCH_SIZE,
    orderBy: { dateTime: 'asc' },
    include: {
      restaurant: { select: { id: true, name: true } },
    },
  });

  const candidates = [];
  for (const r of reservations) {
    const survey = surveyByRestaurant.get(r.restaurantId);
    if (!survey) continue;

    const { eligible } = checkReservationEligibility(r, survey, now);
    if (!eligible) continue;

    const visitEnd = computeVisitEnd(r.dateTime, r.durationMinutes);
    const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);
    const window = evaluateSendWindow(scheduledFor, survey.sendWindowMinutes, now);

    if (window.tooEarly) {
      candidates.push({ reservation: r, survey, expired: false, enqueueOnly: true });
      continue;
    }
    if (window.expired) {
      candidates.push({ reservation: r, survey, expired: true });
      continue;
    }
    if (window.inWindow) {
      candidates.push({ reservation: r, survey, expired: false });
    }
  }

  return { candidates, surveyByRestaurant, restaurantIds };
}

async function runPostVisitFeedback() {
  if (process.env.FEEDBACK_ENABLED_GLOBAL === 'false') return;

  try {
    const { candidates, surveyByRestaurant, restaurantIds } = await findCandidateReservations();
    if (restaurantIds.length === 0) return;
    let sent = 0;
    let skipped = 0;
    let expired = 0;

    for (const { reservation, survey, expired: isExpired, enqueueOnly } of candidates) {
      if (enqueueOnly) {
        await ensureFeedbackRequestForReservation(reservation, { trySendNow: false });
        continue;
      }

      if (isExpired) {
        try {
          await prisma.feedbackRequest.create({
            data: {
              reservationId: reservation.id,
              restaurantId: reservation.restaurantId,
              customerEmailNormalized: (reservation.customerEmail || '').trim().toLowerCase(),
              scheduledFor: computeScheduledFor(
                computeVisitEnd(reservation.dateTime, reservation.durationMinutes),
                survey.sendDelayMinutes
              ),
              status: 'expired',
              skipReason: 'window_expired',
            },
          });
        } catch (err) {
          if (err.code !== 'P2002') throw err;
        }
        expired++;
        continue;
      }

      const canSend = await canSendFeedback(reservation.restaurantId);
      const result = await processFeedbackRequest({
        reservation,
        survey,
        canSend,
      });

      if (result.sent) sent++;
      else if (result.skipped) skipped++;
    }

    const pendingToSend = await prisma.feedbackRequest.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        status: 'pending',
        sentAt: null,
      },
      include: { reservation: true },
      take: BATCH_SIZE,
    });

    for (const req of pendingToSend) {
      if (!req.reservation) continue;
      const survey = surveyByRestaurant.get(req.restaurantId);
      if (!survey?.enabled) continue;

      const visitEnd = computeVisitEnd(req.reservation.dateTime, req.reservation.durationMinutes);
      const scheduledFor = computeScheduledFor(visitEnd, survey.sendDelayMinutes);
      const window = evaluateSendWindow(scheduledFor, survey.sendWindowMinutes, new Date());
      if (!window.inWindow) continue;

      const canSend = await canSendFeedback(req.restaurantId);
      const result = await processFeedbackRequest({
        reservation: req.reservation,
        survey,
        canSend,
      });
      if (result.sent) sent++;
      else if (result.skipped) skipped++;
    }

    if (candidates.length > 0) {
      logger.info(
        { sent, skipped, expired, candidates: candidates.length },
        '[FeedbackJob] post-visit feedback run'
      );
    }
  } catch (err) {
    logger.error({ err }, '[FeedbackJob] failed');
  }
}

function startPostVisitFeedbackJob() {
  const schedule = process.env.FEEDBACK_CRON || '*/10 * * * *';
  cron.schedule(schedule, runPostVisitFeedback, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule, tz: process.env.TZ || 'America/Santiago' }, '[FeedbackJob] scheduled');
}

module.exports = { startPostVisitFeedbackJob, runPostVisitFeedback };
