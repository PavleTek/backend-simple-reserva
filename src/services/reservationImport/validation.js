'use strict';

const { DateTime } = require('luxon');
const prisma = require('../../lib/prisma');
const { parseInTimezone, getEffectiveTimezone, nowInTimezone, getDayOfWeekInTimezone } = require('../../utils/timezone');
const { computeBusinessDate } = require('../slotEngine/businessDate');
const { validateSlotForBooking } = require('../slotEngine/validate');
const { pickTable, parseReservations, parseHolds } = require('../slotEngine/capacity');
const { loadBlockingSessionsForDay } = require('../activitySessionService');
const { parseCsvBuffer, applyColumnMapping } = require('./csvParser');
const {
  normalizePhone,
  normalizeEmail,
  parseDateStr,
  parseTimeStr,
  mapStatus,
  parsePartySize,
  durationFromEnd,
} = require('./normalize');
const { DEFAULT_OPTIONS, MAX_ROWS, IMPORT_UNKNOWN_CUSTOMER_NAME, DEFAULT_IMPORT_PARTY_SIZE } = require('./constants');

const ACTIVE_TABLE_STATUSES = ['confirmed', 'arrived'];

function contactKey(row, strategy) {
  const email = row.customerEmail || '';
  const phone = row.customerPhone || '';
  if (strategy === 'email') return email || null;
  if (strategy === 'phone') return phone || null;
  return email || phone || null;
}

function buildNaturalKey(restaurantId, dateTime, contact, tableId, partySize, customerName) {
  if (contact) {
    return `${restaurantId}|${dateTime.toISOString()}|${contact}|${tableId || ''}`;
  }
  return `${restaurantId}|${dateTime.toISOString()}|${partySize}|${tableId || ''}|${customerName || ''}`;
}

async function loadRestaurantContext(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      organization: { include: { owner: { select: { country: true } } } },
      durationRules: true,
      reservationWindows: true,
      pacingRules: true,
      schedules: { where: { isActive: true } },
      zones: {
        where: { isActive: true },
        include: { tables: { where: { isActive: true } } },
      },
    },
  });
  if (!restaurant) return null;

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);

  const tablesByLabel = new Map();
  const tablesByZoneLabel = [];
  for (const zone of restaurant.zones) {
    for (const table of zone.tables) {
      tablesByLabel.set(table.label.trim().toLowerCase(), { table, zone });
      tablesByZoneLabel.push({ table, zone });
    }
  }

  const maxTableCapacity = restaurant.zones.reduce((max, z) => {
    for (const t of z.tables) {
      if (t.maxCapacity > max) max = t.maxCapacity;
    }
    return max;
  }, 0);

  return { restaurant, timezone, tablesByLabel, tablesByZoneLabel, maxTableCapacity };
}

function resolveTable(ctx, tableLabel, zoneName) {
  if (!tableLabel && !zoneName) return { tableId: null, warning: null };

  const labelNorm = tableLabel ? String(tableLabel).trim().toLowerCase() : null;
  const zoneNorm = zoneName ? String(zoneName).trim().toLowerCase() : null;

  if (labelNorm && ctx.tablesByLabel.has(labelNorm)) {
    const { table, zone } = ctx.tablesByLabel.get(labelNorm);
    if (zoneNorm && zone.name.trim().toLowerCase() !== zoneNorm) {
      return { tableId: table.id, warning: 'zona_no_coincide' };
    }
    return { tableId: table.id, warning: null };
  }

  if (labelNorm) {
    return { tableId: null, warning: 'mesa_desconocida' };
  }

  if (zoneNorm) {
    const inZone = ctx.tablesByZoneLabel.filter((x) => x.zone.name.trim().toLowerCase() === zoneNorm);
    if (inZone.length === 1) return { tableId: inZone[0].table.id, warning: 'mesa_auto_zona' };
    if (inZone.length > 1) return { tableId: null, warning: 'zona_ambigua' };
    return { tableId: null, warning: 'zona_desconocida' };
  }

  return { tableId: null, warning: null };
}

async function validateRow(rawRow, rowNumber, ctx, options, existingKeys, fileDuplicateKeys, now) {
  const errors = [];
  const warnings = [];

  const date = parseDateStr(rawRow.date);
  const startTime = parseTimeStr(rawRow.startTime);
  if (!date) errors.push({ field: 'date', reason: 'fecha_invalida' });
  if (!startTime) errors.push({ field: 'startTime', reason: 'hora_inicio_invalida' });

  const customerNameRaw = String(rawRow.customerName || '').trim();
  const customerName = customerNameRaw || IMPORT_UNKNOWN_CUSTOMER_NAME;
  if (!customerNameRaw) {
    warnings.push({ field: 'customerName', reason: 'nombre_por_defecto' });
  }

  let partySize = parsePartySize(rawRow.partySize);
  if (!partySize) {
    partySize = DEFAULT_IMPORT_PARTY_SIZE;
    warnings.push({ field: 'partySize', reason: 'comensales_por_defecto' });
  }

  const emailResult = normalizeEmail(rawRow.customerEmail);
  if (emailResult?.invalid) warnings.push({ field: 'customerEmail', reason: 'email_invalido' });
  const customerEmail = emailResult?.value || null;
  const customerPhone = normalizePhone(rawRow.customerPhone);

  const { restaurant, timezone, maxTableCapacity } = ctx;

  // Migración: no exigimos email/teléfono aunque el restaurante los pida en reserva web
  if (!customerEmail && !customerPhone && !customerNameRaw) {
    warnings.push({ field: 'customerName', reason: 'sin_datos_cliente' });
  }

  const statusRaw = String(rawRow.status || '').trim();
  const status = statusRaw ? mapStatus(rawRow.status) : 'confirmed';
  if (statusRaw && !status) errors.push({ field: 'status', reason: 'estado_invalido' });

  if (errors.length) {
    return { ok: false, errors, warnings, rowNumber };
  }

  let durationMinutes = null;
  const endTime = parseTimeStr(rawRow.endTime);
  if (rawRow.durationMinutes) {
    durationMinutes = parseInt(String(rawRow.durationMinutes).trim(), 10);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      errors.push({ field: 'durationMinutes', reason: 'duracion_invalida' });
    }
  } else if (endTime) {
    durationMinutes = durationFromEnd(startTime, endTime);
  } else {
    durationMinutes = restaurant.defaultSlotDurationMinutes;
  }

  if (errors.length) return { ok: false, errors, warnings, rowNumber };

  let dateTime;
  try {
    dateTime = parseInTimezone(date, startTime, timezone);
  } catch {
    errors.push({ field: 'dateTime', reason: 'fecha_hora_invalida' });
    return { ok: false, errors, warnings, rowNumber };
  }

  const isFuture = dateTime > now;
  if (!isFuture && (status === 'completed' || status === 'no_show') === false && status === 'confirmed') {
    // confirmed past is fine
  }
  if (isFuture && (status === 'completed' || status === 'no_show')) {
    errors.push({ field: 'status', reason: 'estado_futuro_invalido' });
    return { ok: false, errors, warnings, rowNumber };
  }

  if (partySize > maxTableCapacity && maxTableCapacity > 0) {
    warnings.push({ field: 'partySize', reason: 'excede_capacidad_mesa' });
  }

  const dayOfWeek = getDayOfWeekInTimezone(date, timezone);
  const schedule = ctx.restaurant.schedules.find((s) => s.dayOfWeek === dayOfWeek) || null;

  let businessDateStr = date;
  if (schedule) {
    businessDateStr = computeBusinessDate(date, startTime, schedule, restaurant.scheduleMode, timezone);
  }
  const businessDateValue = new Date(`${businessDateStr}T12:00:00.000Z`);

  let notes = String(rawRow.notes || '').trim() || null;
  if (options.appendMetaToNotes) {
    const extras = [];
    if (rawRow.serviceNote) extras.push(`Servicio (referencia): ${rawRow.serviceNote}`);
    if (rawRow.professionalNote) extras.push(`Profesional (referencia): ${rawRow.professionalNote}`);
    if (extras.length) notes = [notes, ...extras].filter(Boolean).join('\n');
  }

  const { tableId, warning: tableWarning } = resolveTable(ctx, rawRow.tableLabel, rawRow.zoneName);
  if (tableWarning) warnings.push({ field: 'tableLabel', reason: tableWarning });

  const rowContact = contactKey({ customerEmail, customerPhone }, options.matchingStrategy || 'both');
  const naturalKey = buildNaturalKey(
    restaurant.id,
    dateTime,
    rowContact,
    tableId,
    partySize,
    customerName,
  );

  if (fileDuplicateKeys.has(naturalKey)) {
    return { ok: false, skip: true, reason: 'duplicado_en_archivo', rowNumber, warnings };
  }
  fileDuplicateKeys.add(naturalKey);

  if (existingKeys.has(naturalKey)) {
    if (options.conflictPolicy === 'duplicate') {
      // allow insert
    } else {
      return { ok: false, skip: true, reason: 'conflicto_existente', rowNumber, warnings };
    }
  }

  let assignedTableId = tableId;

  if (isFuture && status === 'confirmed') {
    const customWindows =
      restaurant.reservationWindowMode === 'custom'
        ? ctx.restaurant.reservationWindows.filter((w) => w.dayOfWeek === dayOfWeek)
        : [];

    const tables = ctx.restaurant.zones.flatMap((z) =>
      z.tables.map((t) => ({
        id: t.id,
        zoneId: z.id,
        minCapacity: t.minCapacity,
        maxCapacity: t.maxCapacity,
        sortOrder: t.sortOrder ?? 0,
        zoneSortOrder: z.sortOrder ?? 0,
        zone: { id: z.id, sortOrder: z.sortOrder ?? 0 },
      })),
    );

    const lb = restaurant.defaultSlotDurationMinutes * 2;
    const windowStart = new Date(dateTime.getTime() - lb * 60000);
    const windowEnd = parseInTimezone(date, '23:59', timezone);

    const dayReservations = await prisma.reservation.findMany({
      where: {
        restaurantId: restaurant.id,
        status: { in: ACTIVE_TABLE_STATUSES },
        dateTime: { gte: windowStart, lte: windowEnd },
      },
      select: { tableId: true, dateTime: true, durationMinutes: true },
    });

    const blockingSessions = await loadBlockingSessionsForDay(
      restaurant.id,
      windowStart,
      new Date(dateTime.getTime() + durationMinutes * 60000),
    );

    const reservationsRaw = dayReservations.map((r) => ({
      tableId: r.tableId,
      startUtc: r.dateTime.toISOString(),
      durationMinutes: r.durationMinutes,
    }));

    const validation = validateSlotForBooking({
      time: startTime,
      partySize,
      schedule: schedule ? { ...schedule, scheduleMode: restaurant.scheduleMode } : null,
      restaurant,
      durationRules: ctx.restaurant.durationRules,
      customWindows,
      tables,
      reservations: reservationsRaw,
      activeHolds: [],
      blockedSlots: [],
      pacingRules: ctx.restaurant.pacingRules.map((p) => ({
        dayOfWeek: p.dayOfWeek,
        maxCoversPerSlot: p.maxCoversPerSlot,
        maxReservationsPerSlot: p.maxReservationsPerSlot,
      })),
      slotDateTime: dateTime,
      now,
      isToday: date === nowInTimezone(timezone).toFormat('yyyy-MM-dd'),
      walkIn: false,
      zoneId: null,
      excludeHoldToken: null,
      dayOfWeek,
      blockingSessions,
    });

    if (!validation.valid && !assignedTableId) {
      errors.push({ field: 'dateTime', reason: validation.reason || 'sin_disponibilidad' });
      return { ok: false, errors, warnings, rowNumber };
    }

    if (!assignedTableId && validation.valid) {
      const slotEnd = new Date(dateTime.getTime() + durationMinutes * 60000);
      const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
      const selected = pickTable(
        tables,
        partySize,
        dateTime,
        slotEnd,
        bufferMs,
        parseReservations(reservationsRaw),
        parseHolds([]),
        null,
        null,
        {},
        blockingSessions,
      );
      if (selected) assignedTableId = selected.id;
      else errors.push({ field: 'dateTime', reason: 'sin_mesa_disponible' });
    }
  }

  if (errors.length) return { ok: false, errors, warnings, rowNumber };

  return {
    ok: true,
    rowNumber,
    warnings,
    payload: {
      restaurantId: restaurant.id,
      tableId: assignedTableId,
      customerName,
      customerPhone,
      customerEmail,
      partySize,
      dateTime: dateTime.toISOString(),
      businessDate: businessDateValue.toISOString().slice(0, 10),
      durationMinutes,
      status,
      notes,
      source: 'imported',
      isFuture,
    },
  };
}

async function loadExistingKeys(restaurantId, strategy) {
  const rows = await prisma.reservation.findMany({
    where: { restaurantId, status: { not: 'cancelled' } },
    select: {
      id: true,
      dateTime: true,
      customerEmail: true,
      customerPhone: true,
      customerName: true,
      partySize: true,
      tableId: true,
    },
  });

  const keys = new Set();
  for (const r of rows) {
    const contact = contactKey(
      { customerEmail: r.customerEmail, customerPhone: r.customerPhone },
      strategy,
    );
    keys.add(
      buildNaturalKey(
        restaurantId,
        r.dateTime,
        contact,
        r.tableId,
        r.partySize,
        r.customerName,
      ),
    );
  }
  return keys;
}

async function validateImportBatch({ importRecord, columnMapping, options }) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const ctx = await loadRestaurantContext(importRecord.restaurantId);
  if (!ctx) throw new Error('Restaurante no encontrado');

  if (ctx.restaurant.organizationId !== importRecord.organizationId) {
    throw new Error('El restaurante no pertenece a la organización');
  }

  const { readBuffer } = require('./storage');
  const buffer = await readBuffer(importRecord.fileKey);
  const records = parseCsvBuffer(buffer);

  if (records.length > MAX_ROWS) {
    throw new Error(`El archivo supera el máximo de ${MAX_ROWS} filas`);
  }

  const existingKeys = await loadExistingKeys(importRecord.restaurantId, mergedOptions.matchingStrategy);
  const fileDuplicateKeys = new Set();
  const now = new Date();

  const validRows = [];
  const errorRows = [];
  const skippedRows = [];
  const previewSample = [];
  const ruleCounts = {};

  function bump(rule) {
    ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
  }

  for (let i = 0; i < records.length; i++) {
    const rowNumber = i + 2;
    const mapped = applyColumnMapping(records[i], columnMapping);
    const result = await validateRow(mapped, rowNumber, ctx, mergedOptions, existingKeys, fileDuplicateKeys, now);

    if (result.skip) {
      skippedRows.push({ rowNumber, reason: result.reason, warnings: result.warnings });
      bump(result.reason);
      continue;
    }

    if (!result.ok) {
      for (const e of result.errors || []) {
        errorRows.push({ rowNumber, field: e.field, reason: e.reason });
        bump(e.reason);
      }
      continue;
    }

    for (const w of result.warnings || []) bump(w.reason);
    validRows.push(result.payload);
    if (previewSample.length < 20) {
      previewSample.push({ rowNumber, ...result.payload, warnings: result.warnings });
    }
  }

  const estimatedDurationMs = Math.max(1000, Math.ceil(validRows.length / 500) * 2000);

  return {
    totalRows: records.length,
    validRows: validRows.length,
    invalidRows: errorRows.length,
    skippedRows: skippedRows.length,
    validPayloads: validRows,
    errorRows,
    skippedRowsDetail: skippedRows,
    previewSample,
    ruleCounts,
    estimatedDurationMs,
    timezone: ctx.timezone,
  };
}

function buildErrorCsv(errorRows, skippedRows) {
  const lines = ['fila,campo,motivo,tipo'];
  for (const e of errorRows) {
    lines.push(`${e.rowNumber},${e.field},${e.reason},error`);
  }
  for (const s of skippedRows) {
    lines.push(`${s.rowNumber},,${s.reason},omitido`);
  }
  return lines.join('\n');
}

module.exports = {
  validateImportBatch,
  buildErrorCsv,
  loadRestaurantContext,
  contactKey,
  buildNaturalKey,
};
