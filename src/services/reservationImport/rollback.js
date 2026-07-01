'use strict';

const prisma = require('../../lib/prisma');
const { recomputeAnalyticsForDates } = require('./analytics');

const DELETE_CHUNK = 500;

async function rollbackImportBatch(importRecord, { force = false, filters = {} } = {}) {
  const now = new Date();
  if (importRecord.rollbackAvailableUntil && now > importRecord.rollbackAvailableUntil && !force) {
    throw new Error('El período de rollback expiró');
  }

  if (!['completed', 'failed'].includes(importRecord.status)) {
    throw new Error('Solo se puede revertir una migración completada o fallida parcialmente');
  }

  await prisma.reservationImport.update({
    where: { id: importRecord.id },
    data: { status: 'rolling_back' },
  });

  const where = {
    importId: importRecord.id,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          businessDate: {
            ...(filters.dateFrom ? { gte: new Date(`${filters.dateFrom}T12:00:00.000Z`) } : {}),
            ...(filters.dateTo ? { lte: new Date(`${filters.dateTo}T12:00:00.000Z`) } : {}),
          },
        }
      : {}),
    ...(filters.onlyHistorical
      ? { dateTime: { lt: new Date() } }
      : {}),
  };

  let deleted = 0;
  let skippedEdited = 0;
  const affectedDates = new Set();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await prisma.reservation.findMany({
      where,
      take: DELETE_CHUNK,
      select: {
        id: true,
        updatedAt: true,
        businessDate: true,
      },
    });

    if (!batch.length) break;

    const idsToDelete = [];
    for (const r of batch) {
      const editedAfterImport =
        importRecord.completedAt && r.updatedAt > importRecord.completedAt;
      if (editedAfterImport && !force) {
        skippedEdited += 1;
        continue;
      }
      idsToDelete.push(r.id);
      if (r.businessDate) {
        affectedDates.add(r.businessDate.toISOString().slice(0, 10));
      }
    }

    if (idsToDelete.length) {
      const result = await prisma.reservation.deleteMany({ where: { id: { in: idsToDelete } } });
      deleted += result.count;
    }

    if (batch.length < DELETE_CHUNK) break;
  }

  const options = importRecord.options || {};
  if (options.affectAnalytics && affectedDates.size > 0) {
    await recomputeAnalyticsForDates(
      importRecord.restaurantId,
      importRecord.organizationId,
      [...affectedDates],
    );
  }

  await prisma.reservationImport.update({
    where: { id: importRecord.id },
    data: {
      status: 'rolled_back',
      rolledBackAt: new Date(),
    },
  });

  return { deleted, skippedEdited };
}

module.exports = { rollbackImportBatch };
