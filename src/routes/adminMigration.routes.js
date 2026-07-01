'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const prisma = require('../lib/prisma');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { writeAuditLog } = require('../services/auditLogService');
const importService = require('../services/reservationImport');
const { uploadBuffer, importFileKey, readBuffer } = require('../services/reservationImport/storage');
const { MAX_FILE_BYTES, RESERVATION_FIELDS, RESERVATION_STATUS_OPTIONS, DEFAULT_OPTIONS, DEFAULT_IMPORT_PARTY_SIZE, IMPORT_UNKNOWN_CUSTOMER_NAME } = require('../services/reservationImport/constants');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

const TEMPLATE_PATH = path.join(__dirname, '../../templates/reservation-import-template.csv');

router.get('/template.csv', (_req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-importacion-reservas.csv"');
    res.sendFile(TEMPLATE_PATH);
  } catch (err) {
    next(err);
  }
});

router.get('/fields', (_req, res) => {
  res.json({
    fields: RESERVATION_FIELDS,
    statusOptions: RESERVATION_STATUS_OPTIONS,
    defaults: {
      partySize: DEFAULT_IMPORT_PARTY_SIZE,
      customerName: IMPORT_UNKNOWN_CUSTOMER_NAME,
      status: 'confirmed',
    },
    defaultOptions: DEFAULT_OPTIONS,
    unsupportedFields: [
      'ID externo de reserva',
      'Servicio / tratamiento',
      'Profesional / colaborador',
      'Precio',
      'Estado de pago',
    ],
    notificationPolicy: {
      past: 'Sin emails ni alertas',
      futureConfirmed: {
        customerConfirmation: false,
        customerReminder: 'Según toggle de importación (default: sí, si hay email/teléfono)',
        teamAlert: 'Según configuración de notificaciones del restaurante (igual que reserva manual)',
      },
    },
  });
});

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { organizationId, restaurantId, status } = req.query;

    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (restaurantId) where.restaurantId = restaurantId;
    if (status) where.status = status;

    const [rows, total] = await Promise.all([
      prisma.reservationImport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.reservationImport.count({ where }),
    ]);

    const restaurantIds = [...new Set(rows.map((r) => r.restaurantId))];
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const userIds = [...new Set(rows.filter((r) => r.createdByUserId).map((r) => r.createdByUserId))];

    const [restaurants, orgs, users] = await Promise.all([
      prisma.restaurant.findMany({
        where: { id: { in: restaurantIds } },
        select: { id: true, name: true, slug: true },
      }),
      prisma.restaurantOrganization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      }),
      userIds.length
        ? prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, name: true, lastName: true },
          })
        : [],
    ]);

    const restaurantMap = Object.fromEntries(restaurants.map((r) => [r.id, r]));
    const orgMap = Object.fromEntries(orgs.map((o) => [o.id, o]));
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const enriched = rows.map((row) => ({
      ...row,
      restaurant: restaurantMap[row.restaurantId] || null,
      organization: orgMap[row.organizationId] || null,
      createdBy: row.createdByUserId ? userMap[row.createdByUserId] || null : null,
    }));

    res.json(paginatedResponse(enriched, total, page, limit));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await importService.getImportOrThrow(req.params.id);
    const [restaurant, organization, createdBy] = await Promise.all([
      prisma.restaurant.findUnique({
        where: { id: record.restaurantId },
        select: { id: true, name: true, slug: true, timezone: true },
      }),
      prisma.restaurantOrganization.findUnique({
        where: { id: record.organizationId },
        select: { id: true, name: true },
      }),
      record.createdByUserId
        ? prisma.user.findUnique({
            where: { id: record.createdByUserId },
            select: { id: true, email: true, name: true, lastName: true },
          })
        : null,
    ]);

    res.json({ ...record, restaurant, organization, createdBy });
  } catch (err) {
    next(err);
  }
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    const { organizationId, restaurantId } = req.body;
    if (!organizationId || !restaurantId) {
      throw new ValidationError('organizationId y restaurantId son obligatorios');
    }
    if (!req.file) throw new ValidationError('Debes subir un archivo CSV');

    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (ext && ext !== '.csv') {
      throw new ValidationError('Solo se aceptan archivos CSV en esta versión');
    }

    await importService.assertRestaurantInOrg(organizationId, restaurantId);

    const record = await prisma.reservationImport.create({
      data: {
        organizationId,
        restaurantId,
        createdByUserId: req.user?.id || null,
        status: 'uploaded',
        source: 'csv',
        fileName: req.file.originalname,
        fileSize: req.file.size,
      },
    });

    const fileKey = importFileKey(record.id, 'source', 'csv');
    await uploadBuffer(fileKey, req.file.buffer, 'text/csv');

    const { headers, mapping, rowCount } = importService.suggestMappingFromFile(req.file.buffer);

    const updated = await prisma.reservationImport.update({
      where: { id: record.id },
      data: {
        fileKey,
        columnMapping: mapping,
        totalRows: rowCount || 0,
      },
    });

    await writeAuditLog({
      actorUserId: req.user?.id,
      restaurantId,
      action: 'reservation.import.upload',
      resourceType: 'ReservationImport',
      resourceId: record.id,
      metadata: { fileName: req.file.originalname, rowCount },
    });

    res.status(201).json({
      ...updated,
      detectedHeaders: headers,
      suggestedMapping: mapping,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/mapping', async (req, res, next) => {
  try {
    const record = await importService.getImportOrThrow(req.params.id);
    if (!['uploaded', 'validated'].includes(record.status)) {
      throw new ValidationError('No se puede editar el mapeo en el estado actual');
    }

    const { columnMapping, options } = req.body;
    if (!columnMapping || typeof columnMapping !== 'object') {
      throw new ValidationError('columnMapping es obligatorio');
    }

    const required = ['date', 'startTime'];
    for (const key of required) {
      if (!columnMapping[key]) {
        throw new ValidationError(`Falta mapear el campo obligatorio: ${key}`);
      }
    }

    const mergedOptions = { ...DEFAULT_OPTIONS, ...(record.options || {}), ...(options || {}) };

    const updated = await prisma.reservationImport.update({
      where: { id: record.id },
      data: {
        columnMapping,
        options: mergedOptions,
        status: record.status === 'validated' ? 'uploaded' : record.status,
        summary: record.status === 'validated' ? null : record.summary,
        validatedFileKey: record.status === 'validated' ? null : record.validatedFileKey,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/validate', async (req, res, next) => {
  try {
    const record = await importService.getImportOrThrow(req.params.id);
    if (!['uploaded', 'validated'].includes(record.status)) {
      throw new ValidationError('La migración no está en un estado válido para validar');
    }

    const updated = await importService.runValidation(record.id);

    await writeAuditLog({
      actorUserId: req.user?.id,
      restaurantId: record.restaurantId,
      action: 'reservation.import.validate',
      resourceType: 'ReservationImport',
      resourceId: record.id,
      metadata: {
        validRows: updated.validRows,
        invalidRows: updated.invalidRows,
        skippedRows: updated.skippedRows,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/execute', async (req, res, next) => {
  try {
    const updated = await importService.queueExecution(req.params.id, req.user?.id);
    res.status(202).json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/errors.csv', async (req, res, next) => {
  try {
    const record = await importService.getImportOrThrow(req.params.id);
    if (!record.errorReportKey) throw new NotFoundError('No hay reporte de errores');

    const buffer = await readBuffer(record.errorReportKey);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errores-migracion-${record.id}.csv"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/rollback', async (req, res, next) => {
  try {
    const result = await importService.runRollback(req.params.id, req.user?.id, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
