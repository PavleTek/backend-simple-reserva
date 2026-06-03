'use strict';

/**
 * Cron job: procesa bajas programadas de add-ons cuya fecha ya pasó.
 * Apaga isActive en SubscriptionAddon donde removalScheduledFor <= now.
 *
 * Se ejecuta cada hora. Corre junto al planChangeSchedulerJob y los demás
 * trabajos de billing; bajo withCronLock para evitar ejecuciones simultáneas.
 */

const cron = require('node-cron');
const { withCronLock } = require('../lib/cronLock');
const { processDueAddonRemovals } = require('../services/billing/subscriptionAddonService');
const logger = require('../lib/logger');

const CRON = process.env.ADDON_REMOVAL_CRON || '5 * * * *'; // cada hora a los 5 min

async function runAddonRemovalJob() {
  const count = await processDueAddonRemovals();
  if (count > 0) {
    logger.info('[addonRemovalJob] Add-ons desactivados por baja programada', { count });
  }
}

function startAddonRemovalJob() {
  if (process.env.ADDON_REMOVAL_JOB_ENABLED === 'false') return;
  cron.schedule(CRON, () => {
    withCronLock('addonRemoval', runAddonRemovalJob).catch((err) => {
      logger.error('[addonRemovalJob] Job falló', { error: err?.message ?? err });
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info('[addonRemovalJob] Programado', { cron: CRON });
}

module.exports = { startAddonRemovalJob, runAddonRemovalJob };
