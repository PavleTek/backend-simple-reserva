const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG, ROLES_CONFIG_VIEW } = require('../auth/roles');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');
const { incrementDataVersion } = require('../utils/dataVersion');
const { validateNoOverlap } = require('../lib/floorPlanUtils');

const ALLOWED_SHAPES = new Set(['square', 'rectangular', 'round']);
const ALLOWED_ROTATION = new Set([0, 90, 180, 270]);
const MAX_TABLE_CAPACITY = 300;

function shapeDimensions(shape) {
  if (shape === 'rectangular') return { width: 2, height: 1 };
  return { width: 1, height: 1 };
}

function validateCapacityValue(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > MAX_TABLE_CAPACITY) {
    throw new ValidationError(`${label} debe estar entre 1 y ${MAX_TABLE_CAPACITY}.`);
  }
  return n;
}

function validateCapacityRange(minCapacity, maxCapacity) {
  if (maxCapacity === undefined) {
    throw new ValidationError('Se requiere maxCapacity');
  }
  const minC = validateCapacityValue(minCapacity ?? 1, 'La capacidad mínima');
  const maxC = validateCapacityValue(maxCapacity, 'La capacidad máxima');
  if (minC > maxC) {
    throw new ValidationError('La capacidad mínima no puede ser mayor que la máxima.');
  }
  return { minC, maxC };
}

function validateShape(shape) {
  if (shape !== undefined && !ALLOWED_SHAPES.has(shape)) {
    throw new ValidationError('Forma de mesa no válida.');
  }
}

function buildBatchLabels(prefix, startNumber, count, existingLabels) {
  const used = new Set(existingLabels.map((l) => String(l).trim().toLowerCase()));
  const base = String(prefix ?? 'M').trim() || 'M';
  const start = Number.isFinite(Number(startNumber)) ? Math.max(1, Number(startNumber)) : 1;
  const labels = [];
  let n = start;
  while (labels.length < count) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate.toLowerCase())) {
      labels.push(candidate);
      used.add(candidate.toLowerCase());
    }
    n += 1;
    if (n > start + count + 500) {
      throw new ValidationError('No se pudieron generar nombres únicos para todas las mesas.');
    }
  }
  return labels;
}

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

router.get('/zone/:zoneId', authenticateRestaurantRoles(ROLES_CONFIG_VIEW), async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.zoneId },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const tables = await prisma.restaurantTable.findMany({
      where: { zoneId: req.params.zoneId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });

    res.json(tables);
  } catch (error) {
    next(error);
  }
});

router.post('/zone/:zoneId/batch-create', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.zoneId },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const {
      count,
      labelPrefix,
      startNumber,
      minCapacity,
      maxCapacity,
      shape,
    } = req.body;

    const tableCount = parseInt(count, 10);
    if (!Number.isFinite(tableCount) || tableCount < 1 || tableCount > 50) {
      throw new ValidationError('La cantidad debe ser entre 1 y 50 mesas.');
    }

    const canAdd = await planService.canAddTables(zone.restaurantId, tableCount, true);
    if (!canAdd.allowed) {
      throw new ValidationError(canAdd.reason || 'Límite de mesas alcanzado');
    }

    const resolvedShape = shape !== undefined ? shape : 'square';
    validateShape(resolvedShape);
    const { minC, maxC } = validateCapacityRange(minCapacity, maxCapacity);
    const { width, height } = shapeDimensions(resolvedShape);

    const existing = await prisma.restaurantTable.findMany({
      where: { zoneId: req.params.zoneId, isActive: true },
      select: { label: true, sortOrder: true },
      orderBy: { sortOrder: 'desc' },
    });
    const labels = buildBatchLabels(labelPrefix, startNumber, tableCount, existing.map((t) => t.label));
    const baseSort = (existing[0]?.sortOrder ?? -1) + 1;

    const created = await prisma.$transaction(
      labels.map((label, index) =>
        prisma.restaurantTable.create({
          data: {
            zoneId: req.params.zoneId,
            label,
            minCapacity: minC,
            maxCapacity: maxC,
            sortOrder: baseSort + index,
            shape: resolvedShape,
            width,
            height,
          },
        }),
      ),
    );

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.status(201).json({ created, count: created.length });
  } catch (error) {
    next(error);
  }
});

router.post('/zone/:zoneId', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.zoneId },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const canAdd = await planService.canAddTable(zone.restaurantId, true);
    if (!canAdd.allowed) {
      throw new ValidationError(canAdd.reason || 'Límite de mesas alcanzado');
    }

    const {
      label,
      minCapacity,
      maxCapacity,
      posX,
      posY,
      rotation,
      shape,
      width,
      height,
    } = req.body;

    if (!label || maxCapacity === undefined) {
      throw new ValidationError('Se requiere label y maxCapacity');
    }

    const { minC, maxC } = validateCapacityRange(minCapacity, maxCapacity);

    if (shape !== undefined && !ALLOWED_SHAPES.has(shape)) {
      throw new ValidationError('Forma de mesa no válida.');
    }
    if (rotation !== undefined && !ALLOWED_ROTATION.has(Number(rotation))) {
      throw new ValidationError('Rotación debe ser 0, 90, 180 u 270.');
    }
    const w = width !== undefined ? Number(width) : 1;
    const h = height !== undefined ? Number(height) : 1;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 20 || h > 20) {
      throw new ValidationError('Ancho y alto de mesa deben estar entre 1 y 20 celdas.');
    }

    const lastInZone = await prisma.restaurantTable.findFirst({
      where: { zoneId: req.params.zoneId, isActive: true },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextSort = (lastInZone?.sortOrder ?? -1) + 1;

    const tentative = {
      id: '__new__',
      posX: posX !== undefined ? posX : null,
      posY: posY !== undefined ? posY : null,
      rotation: rotation !== undefined ? Number(rotation) : 0,
      shape: shape !== undefined ? shape : 'square',
      width: w,
      height: h,
    };

    const existing = await prisma.restaurantTable.findMany({
      where: { zoneId: req.params.zoneId, isActive: true },
    });
    if (tentative.posX != null && tentative.posY != null) {
      const merged = [...existing, tentative];
      const v = validateNoOverlap(merged, zone.gridCols, zone.gridRows);
      if (!v.ok) throw new ValidationError(v.message);
    }

    const table = await prisma.restaurantTable.create({
      data: {
        zoneId: req.params.zoneId,
        label,
        minCapacity: minC,
        maxCapacity: maxC,
        sortOrder: nextSort,
        ...(posX !== undefined && { posX }),
        ...(posY !== undefined && { posY }),
        ...(rotation !== undefined && { rotation: Number(rotation) }),
        shape: shape !== undefined ? shape : 'square',
        width: shape !== undefined ? shapeDimensions(shape).width : w,
        height: shape !== undefined ? shapeDimensions(shape).height : h,
      },
    });

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.status(201).json(table);
  } catch (error) {
    next(error);
  }
});

router.put('/zone/:zoneId/reorder', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { tableIds } = req.body;
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
      throw new ValidationError('Se requiere tableIds como array no vacío');
    }
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.zoneId },
      include: {
        tables: { where: { isActive: true }, select: { id: true } },
      },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const activeIds = new Set(zone.tables.map((t) => t.id));
    if (tableIds.length !== activeIds.size || !tableIds.every((id) => activeIds.has(id))) {
      throw new ValidationError(
        'La lista debe incluir exactamente una vez cada mesa activa de la zona',
      );
    }

    await prisma.$transaction(
      tableIds.map((id, index) =>
        prisma.restaurantTable.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put('/zone/:zoneId/layout', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { placements } = req.body;
    if (!Array.isArray(placements)) {
      throw new ValidationError('Se requiere placements como array.');
    }

    const zone = await prisma.zone.findUnique({
      where: { id: req.params.zoneId },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const tables = await prisma.restaurantTable.findMany({
      where: { zoneId: req.params.zoneId, isActive: true },
    });
    const tableById = new Map(tables.map((t) => [t.id, t]));

    for (const p of placements) {
      if (!p || typeof p.id !== 'string') {
        throw new ValidationError('Cada ítem debe tener id de mesa.');
      }
      if (!tableById.has(p.id)) {
        throw new ValidationError('Una de las mesas no pertenece a esta zona.');
      }
      if (p.rotation !== undefined && !ALLOWED_ROTATION.has(Number(p.rotation))) {
        throw new ValidationError('Rotación debe ser 0, 90, 180 u 270.');
      }
    }

    const placementById = new Map(placements.map((p) => [p.id, p]));

    const merged = tables.map((t) => {
      const p = placementById.get(t.id);
      if (!p) return t;
      return {
        ...t,
        posX: Object.prototype.hasOwnProperty.call(p, 'posX') ? p.posX : t.posX,
        posY: Object.prototype.hasOwnProperty.call(p, 'posY') ? p.posY : t.posY,
        rotation:
          p.rotation !== undefined ? Number(p.rotation) : t.rotation,
      };
    });

    const fixtures = await prisma.zoneFixture.findMany({
      where: { zoneId: zone.id },
    });

    const check = validateNoOverlap(merged, zone.gridCols, zone.gridRows, fixtures);
    if (!check.ok) {
      throw new ValidationError(check.message);
    }

    await prisma.$transaction(
      placements.map((p) => {
        const data = {};
        if (Object.prototype.hasOwnProperty.call(p, 'posX')) data.posX = p.posX;
        if (Object.prototype.hasOwnProperty.call(p, 'posY')) data.posY = p.posY;
        if (p.rotation !== undefined) data.rotation = Number(p.rotation);
        return prisma.restaurantTable.update({
          where: { id: p.id },
          data,
        });
      }),
    );

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.patch('/batch-update', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { tableIds, minCapacity, maxCapacity, shape } = req.body;
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
      throw new ValidationError('Se requiere tableIds como array no vacío');
    }
    if (
      minCapacity === undefined &&
      maxCapacity === undefined &&
      shape === undefined
    ) {
      throw new ValidationError('Indica al menos capacidad o forma para actualizar.');
    }

    validateShape(shape);

    const tables = await prisma.restaurantTable.findMany({
      where: {
        id: { in: tableIds },
        isActive: true,
        zone: { restaurantId: req.activeRestaurant.restaurantId, isActive: true },
      },
      include: { zone: true },
    });

    if (tables.length !== tableIds.length) {
      throw new ValidationError('Una o más mesas no pertenecen a este local.');
    }

    const updates = tables.map((table) => {
      const nextMin = minCapacity !== undefined ? validateCapacityValue(minCapacity, 'La capacidad mínima') : table.minCapacity;
      const nextMax = maxCapacity !== undefined ? validateCapacityValue(maxCapacity, 'La capacidad máxima') : table.maxCapacity;
      if (nextMin > nextMax) {
        throw new ValidationError(`Capacidad inválida en mesa «${table.label}».`);
      }
      const nextShape = shape !== undefined ? shape : table.shape;
      const dims = shape !== undefined ? shapeDimensions(nextShape) : { width: table.width, height: table.height };
      return {
        id: table.id,
        data: {
          minCapacity: nextMin,
          maxCapacity: nextMax,
          ...(shape !== undefined && { shape: nextShape, width: dims.width, height: dims.height }),
        },
      };
    });

    await prisma.$transaction(
      updates.map(({ id, data }) =>
        prisma.restaurantTable.update({ where: { id }, data }),
      ),
    );

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json({ updated: updates.length });
  } catch (error) {
    next(error);
  }
});

router.post('/batch-delete', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { tableIds } = req.body;
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
      throw new ValidationError('Se requiere tableIds como array no vacío');
    }

    const tables = await prisma.restaurantTable.findMany({
      where: {
        id: { in: tableIds },
        isActive: true,
        zone: { restaurantId: req.activeRestaurant.restaurantId, isActive: true },
      },
      select: { id: true, label: true },
    });

    if (tables.length !== tableIds.length) {
      throw new ValidationError('Una o más mesas no pertenecen a este local.');
    }

    const blocked = [];
    for (const table of tables) {
      // eslint-disable-next-line no-await-in-loop
      const futureCount = await prisma.reservation.count({
        where: {
          tableId: table.id,
          status: 'confirmed',
          dateTime: { gte: new Date() },
        },
      });
      if (futureCount > 0) {
        blocked.push({ label: table.label, futureCount });
      }
    }

    if (blocked.length > 0) {
      const detail = blocked
        .map((b) => `«${b.label}» (${b.futureCount} reserva(s) futura(s))`)
        .join(', ');
      throw new ValidationError(
        `No se pueden eliminar mesas con reservas futuras: ${detail}. Cancela o reasigna primero.`,
      );
    }

    await prisma.$transaction(
      tableIds.map((id) =>
        prisma.restaurantTable.update({
          where: { id },
          data: { isActive: false },
        }),
      ),
    );

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json({ deleted: tableIds.length });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const table = await prisma.restaurantTable.findUnique({
      where: { id: req.params.id },
      include: { zone: true },
    });

    if (!table || table.zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Mesa no encontrada');
    }

    const {
      label,
      minCapacity,
      maxCapacity,
      posX,
      posY,
      rotation,
      shape,
      width,
      height,
    } = req.body;

    const nextMin = minCapacity !== undefined ? validateCapacityValue(minCapacity, 'La capacidad mínima') : table.minCapacity;
    const nextMax = maxCapacity !== undefined ? validateCapacityValue(maxCapacity, 'La capacidad máxima') : table.maxCapacity;
    if (nextMin > nextMax) {
      throw new ValidationError('La capacidad mínima no puede ser mayor que la máxima.');
    }

    if (shape !== undefined && !ALLOWED_SHAPES.has(shape)) {
      throw new ValidationError('Forma de mesa no válida.');
    }
    if (rotation !== undefined && !ALLOWED_ROTATION.has(Number(rotation))) {
      throw new ValidationError('Rotación debe ser 0, 90, 180 u 270.');
    }

    const nw = width !== undefined ? Number(width) : table.width;
    const nh = height !== undefined ? Number(height) : table.height;
    if (
      (width !== undefined || height !== undefined) &&
      (!Number.isFinite(nw) || !Number.isFinite(nh) || nw < 1 || nh < 1 || nw > 20 || nh > 20)
    ) {
      throw new ValidationError('Ancho y alto de mesa deben estar entre 1 y 20 celdas.');
    }

    const updatedVirtual = {
      ...table,
      label: label !== undefined ? label : table.label,
      minCapacity: nextMin,
      maxCapacity: nextMax,
      posX: Object.prototype.hasOwnProperty.call(req.body, 'posX') ? posX : table.posX,
      posY: Object.prototype.hasOwnProperty.call(req.body, 'posY') ? posY : table.posY,
      rotation: rotation !== undefined ? Number(rotation) : table.rotation,
      shape: shape !== undefined ? shape : table.shape,
      width: nw,
      height: nh,
    };

    const others = await prisma.restaurantTable.findMany({
      where: { zoneId: table.zoneId, isActive: true, NOT: { id: table.id } },
    });
    const merged = [...others, updatedVirtual];
    const check = validateNoOverlap(merged, table.zone.gridCols, table.zone.gridRows);
    if (!check.ok) {
      throw new ValidationError(check.message);
    }

    const updated = await prisma.restaurantTable.update({
      where: { id: req.params.id },
      data: {
        ...(label !== undefined && { label }),
        ...(minCapacity !== undefined && { minCapacity: nextMin }),
        ...(maxCapacity !== undefined && { maxCapacity: nextMax }),
        ...(Object.prototype.hasOwnProperty.call(req.body, 'posX') && { posX }),
        ...(Object.prototype.hasOwnProperty.call(req.body, 'posY') && { posY }),
        ...(rotation !== undefined && { rotation: Number(rotation) }),
        ...(shape !== undefined && { shape }),
        ...(width !== undefined && { width: nw }),
        ...(height !== undefined && { height: nh }),
      },
    });

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const table = await prisma.restaurantTable.findUnique({
      where: { id: req.params.id },
      include: { zone: true },
    });

    if (!table || table.zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Mesa no encontrada');
    }

    const futureCount = await prisma.reservation.count({
      where: {
        tableId: req.params.id,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
    });
    if (futureCount > 0) {
      throw new ValidationError(
        `No se puede eliminar la mesa: tiene ${futureCount} reserva(s) futura(s). Cancela o reasigna primero.`,
      );
    }

    await prisma.restaurantTable.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ message: 'Mesa eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
