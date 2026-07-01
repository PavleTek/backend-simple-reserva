'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { writeAuditLog } = require('../auditLogService');
const { validateImportBatch, buildErrorCsv } = require('./validation');
const { saveValidatedPayloads, processImportBatch } = require('./execute');
const { rollbackImportBatch } = require('./rollback');
const { uploadBuffer, importFileKey, deleteObject } = require('./storage');
const { DEFAULT_OPTIONS, RESERVATION_FIELDS } = require('./constants');
const { detectHeaders } = require('./csvParser');

async function getImportOrThrow(id) {
  const record = await prisma.reservationImport.findUnique({
    where: { id },
    include: {
      reservations: { take: 0 },
    },
  });
  if (!record) throw new NotFoundError('Migración no encontrada');
  return record;
}

async function assertRestaurantInOrg(organizationId, restaurantId) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, organizationId, isDeleted: false },
    select: { id: true, name: true, organizationId: true, timezone: true },
  });
  if (!restaurant) throw new ValidationError('Restaurante no encontrado en la organización');
  return restaurant;
}

async function runValidation(importId) {
  const record = await getImportOrThrow(importId);
  if (!record.fileKey) throw new ValidationError('No hay archivo cargado');

  const columnMapping = record.columnMapping || {};
  const options = { ...DEFAULT_OPTIONS, ...(record.options || {}) };

  const result = await validateImportBatch({
    importRecord: record,
    columnMapping,
    options,
  });

  const errorCsv = buildErrorCsv(result.errorRows, result.skippedRowsDetail);
  const errorKey = importFileKey(importId, 'errors', 'csv');
  await uploadBuffer(errorKey, Buffer.from(errorCsv, 'utf8'), 'text/csv');

  const validatedKey = await saveValidatedPayloads(importId, result.validPayloads);

  const summary = {
    ruleCounts: result.ruleCounts,
    previewSample: result.previewSample,
    estimatedDurationMs: result.estimatedDurationMs,
    timezone: result.timezone,
    skippedSample: result.skippedRowsDetail.slice(0, 20),
    errorSample: result.errorRows.slice(0, 20),
  };

  const updated = await prisma.reservationImport.update({
    where: { id: importId },
    data: {
      status: 'validated',
      totalRows: result.totalRows,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      skippedRows: result.skippedRows,
      summary,
      errorReportKey: errorKey,
      validatedFileKey: validatedKey,
      lastError: null,
    },
  });

  return updated;
}

async function queueExecution(importId, actorUserId) {
  const record = await getImportOrThrow(importId);
  if (record.status !== 'validated') {
    throw new ValidationError('La migración debe estar validada antes de ejecutar');
  }
  if (!record.validatedFileKey || record.validRows === 0) {
    throw new ValidationError('No hay filas válidas para importar');
  }

  const updated = await prisma.reservationImport.update({
    where: { id: importId },
    data: {
      status: 'queued',
      startedAt: new Date(),
      importedRows: 0,
      failedRows: 0,
    },
  });

  await writeAuditLog({
    actorUserId,
    restaurantId: record.restaurantId,
    action: 'reservation.import.execute',
    resourceType: 'ReservationImport',
    resourceId: importId,
    metadata: { validRows: record.validRows },
  });

  return updated;
}

async function runRollback(importId, actorUserId, body = {}) {
  const record = await getImportOrThrow(importId);
  const result = await rollbackImportBatch(record, {
    force: !!body.force,
    filters: {
      status: body.status,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      onlyHistorical: !!body.onlyHistorical,
    },
  });

  await writeAuditLog({
    actorUserId,
    restaurantId: record.restaurantId,
    action: 'reservation.import.rollback',
    resourceType: 'ReservationImport',
    resourceId: importId,
    metadata: result,
  });

  return { ...record, status: 'rolled_back', rollbackResult: result };
}

function suggestMappingFromFile(buffer) {
  const { parseCsvBuffer } = require('./csvParser');
  const records = parseCsvBuffer(buffer);
  if (!records.length) return { headers: [], mapping: {} };
  const headers = Object.keys(records[0]);
  return { headers, mapping: detectHeaders(headers), rowCount: records.length };
}

module.exports = {
  getImportOrThrow,
  assertRestaurantInOrg,
  runValidation,
  queueExecution,
  runRollback,
  suggestMappingFromFile,
  processImportBatch,
  RESERVATION_FIELDS,
  DEFAULT_OPTIONS,
  deleteObject,
};
