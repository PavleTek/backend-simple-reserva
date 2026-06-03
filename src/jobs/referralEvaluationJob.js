/**
 * Evalúa referidos elegibles para aprobación admin y libera créditos de checkouts expirados.
 * Corre diariamente a las 08:00 hora Chile.
 */

const cron = require('node-cron');
const logger = require('../lib/logger');
const { runReferralEvaluationBatch } = require('../services/referralService');

function startReferralEvaluationJob() {
  cron.schedule(
    '0 8 * * *',
    async () => {
      try {
        const result = await runReferralEvaluationBatch();
        logger.info({ result }, '[ReferralEvaluationJob] completed');
      } catch (err) {
        logger.error({ err }, '[ReferralEvaluationJob] failed');
      }
    },
    { timezone: 'America/Santiago' },
  );
  logger.info('[ReferralEvaluationJob] scheduled daily 08:00 America/Santiago');
}

module.exports = { startReferralEvaluationJob, runReferralEvaluationBatch };
