'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { withCronLock } = require('../lib/cronLock');
const { processImportBatch } = require('../services/reservationImport/execute');
const { MAX_RETRIES } = require('../services/reservationImport/constants');

const CRON_EXPR = process.env.RESERVATION_IMPORT_CRON || '*/30 * * * * *';

async function claimNextBatch() {
  const candidate = await prisma.reservationImport.findFirst({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  if (!candidate) return null;

  const updated = await prisma.reservationImport.updateMany({
    where: { id: candidate.id, status: 'queued' },
    data: { status: 'processing' },
  });

  if (updated.count === 0) return null;

  return prisma.reservationImport.findUnique({ where: { id: candidate.id } });
}

async function runReservationImportJob() {
  const batch = await claimNextBatch();
  if (!batch) return;

  logger.info({ importId: batch.id }, '[ReservationImport] Processing batch');

  try {
    await processImportBatch(batch);
    logger.info({ importId: batch.id, imported: batch.importedRows }, '[ReservationImport] Completed');
  } catch (err) {
    logger.error({ err, importId: batch.id }, '[ReservationImport] Failed');

    const fresh = await prisma.reservationImport.findUnique({ where: { id: batch.id } });
    const retries = fresh?.retryCount || 0;

    if (retries < MAX_RETRIES) {
      await prisma.reservationImport.update({
        where: { id: batch.id },
        data: {
          status: 'queued',
          lastError: String(err.message || err).slice(0, 500),
        },
      });
    } else {
      await prisma.reservationImport.update({
        where: { id: batch.id },
        data: {
          status: 'failed',
          lastError: String(err.message || err).slice(0, 500),
          completedAt: new Date(),
        },
      });
    }
  }
}

function startReservationImportJob() {
  cron.schedule(CRON_EXPR, () => {
    withCronLock('reservationImport', runReservationImportJob).catch((err) => {
      logger.error({ err }, '[ReservationImport] Cron error');
    });
  });
  logger.info({ cron: CRON_EXPR }, '[ReservationImport] Job scheduled');
}

module.exports = { startReservationImportJob, runReservationImportJob };
