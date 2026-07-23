'use strict';

/**
 * Evalúa sugerencias para todos los restaurantes activos.
 * Diario 05:00 America/Santiago (configurable con INSIGHTS_CRON).
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { withCronLock } = require('../lib/cronLock');
const { evaluateRestaurant } = require('../services/insightEngine');
const {
  isInsightsEnabledGlobally,
  shouldEvaluateRestaurant,
} = require('../services/insightEngine/config');

function getJobTimezone() {
  return process.env.TZ || 'America/Santiago';
}

async function runInsightsEvaluation() {
  if (!isInsightsEnabledGlobally()) {
    logger.info('[InsightsJob] INSIGHTS_ENABLED is not true — skipping');
    return;
  }

  try {
    const restaurants = await prisma.restaurant.findMany({
      where: { isActive: true, isDeleted: false },
      select: { id: true },
    });

    let evaluated = 0;
    let skipped = 0;
    let errors = 0;

    for (const rest of restaurants) {
      if (!shouldEvaluateRestaurant(rest.id)) {
        skipped += 1;
        continue;
      }
      try {
        const result = await evaluateRestaurant(rest.id);
        if (result?.skipped) skipped += 1;
        else evaluated += 1;
      } catch (err) {
        errors += 1;
        logger.warn({ err, restaurantId: rest.id }, '[InsightsJob] evaluate failed');
      }
    }

    logger.info({ evaluated, skipped, errors, total: restaurants.length }, '[InsightsJob] done');
  } catch (err) {
    logger.error({ err }, '[InsightsJob] failed');
  }
}

function startInsightsJob() {
  const schedule = process.env.INSIGHTS_CRON || '0 5 * * *';
  cron.schedule(
    schedule,
    () => {
      withCronLock('insights', runInsightsEvaluation).catch((err) =>
        logger.error({ err }, '[InsightsJob] lock/run failed'),
      );
    },
    { timezone: getJobTimezone() },
  );
  logger.info({ schedule, tz: getJobTimezone() }, '[InsightsJob] scheduled');
}

module.exports = { startInsightsJob, runInsightsEvaluation };
