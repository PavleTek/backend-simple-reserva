'use strict';

const prisma = require('../../lib/prisma');
const { CHUNK_SIZE, ROLLBACK_DAYS } = require('./constants');
const { readBuffer, uploadBuffer, importFileKey } = require('./storage');
const { recomputeAnalyticsForDates } = require('./analytics');

function buildNotificationFlags(payload, options) {
  const isFuture = payload.isFuture;
  const notifyReminders = options.notifyFutureReminders !== false;

  if (!isFuture) {
    return {
      emailSent: true,
      reminderEmailSent: true,
      teamNotifySent: true,
      teamNotifySkipReason: 'imported',
    };
  }

  return {
    emailSent: true,
    reminderEmailSent: notifyReminders ? false : true,
    teamNotifySent: true,
    teamNotifySkipReason: 'imported',
  };
}

function toCreateData(payload, importId, options) {
  const flags = buildNotificationFlags(payload, options);
  return {
    restaurantId: payload.restaurantId,
    tableId: payload.tableId,
    importId,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerEmail: payload.customerEmail,
    partySize: payload.partySize,
    dateTime: new Date(payload.dateTime),
    businessDate: new Date(`${payload.businessDate}T12:00:00.000Z`),
    durationMinutes: payload.durationMinutes,
    status: payload.status,
    notes: payload.notes,
    source: 'imported',
    ...flags,
  };
}

async function loadValidatedPayloads(importRecord) {
  if (!importRecord.validatedFileKey) {
    throw new Error('No hay archivo validado; ejecuta validación primero');
  }
  const buf = await readBuffer(importRecord.validatedFileKey);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

async function saveValidatedPayloads(importId, payloads) {
  const jsonl = payloads.map((p) => JSON.stringify(p)).join('\n');
  const key = importFileKey(importId, 'validated', 'jsonl');
  await uploadBuffer(key, Buffer.from(jsonl, 'utf8'), 'application/x-ndjson');
  return key;
}

async function processImportBatch(importRecord) {
  const options = { ...(importRecord.options || {}) };
  const allPayloads = await loadValidatedPayloads(importRecord);
  const offset = importRecord.importedRows || 0;
  const toProcess = allPayloads.slice(offset);

  const businessDates = new Set();
  let imported = importRecord.importedRows || 0;
  let failed = importRecord.failedRows || 0;

  for (let i = 0; i < toProcess.length; i += CHUNK_SIZE) {
    const chunk = toProcess.slice(i, i + CHUNK_SIZE);
    const data = chunk.map((p) => toCreateData(p, importRecord.id, options));

    try {
      await prisma.reservation.createMany({ data, skipDuplicates: false });
      imported += chunk.length;
    } catch (err) {
      failed += chunk.length;
      await prisma.reservationImport.update({
        where: { id: importRecord.id },
        data: {
          failedRows: failed,
          lastError: String(err.message || err).slice(0, 500),
          retryCount: { increment: 1 },
        },
      });
      throw err;
    }

    await prisma.reservationImport.update({
      where: { id: importRecord.id },
      data: { importedRows: imported, failedRows: failed },
    });
  }

  if (options.affectAnalytics) {
    const dateRows = await prisma.reservation.findMany({
      where: { importId: importRecord.id },
      select: { businessDate: true },
      distinct: ['businessDate'],
    });
    const dateStrs = dateRows
      .map((r) => r.businessDate?.toISOString().slice(0, 10))
      .filter(Boolean);
    if (dateStrs.length) {
      await recomputeAnalyticsForDates(
        importRecord.restaurantId,
        importRecord.organizationId,
        dateStrs,
      );
    }
  }

  const rollbackUntil = new Date();
  rollbackUntil.setDate(rollbackUntil.getDate() + ROLLBACK_DAYS);

  await prisma.reservationImport.update({
    where: { id: importRecord.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      importedRows: imported,
      failedRows: failed,
      rollbackAvailableUntil: rollbackUntil,
    },
  });

  return { imported, failed };
}

module.exports = {
  buildNotificationFlags,
  toCreateData,
  saveValidatedPayloads,
  loadValidatedPayloads,
  processImportBatch,
};
