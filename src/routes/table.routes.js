const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');
const { incrementDataVersion } = require('../utils/dataVersion');
const { validateNoOverlap } = require('../lib/floorPlanUtils');

const ALLOWED_SHAPES = new Set(['square', 'rectangular', 'round']);
const ALLOWED_ROTATION = new Set([0, 90, 180, 270]);

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(ROLES_CONFIG));

router.get('/zone/:zoneId', async (req, res, next) => {
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

router.post('/zone/:zoneId', async (req, res, next) => {
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

    const minC = minCapacity ?? 1;
    if (minC > maxCapacity) {
      throw new ValidationError('La capacidad mínima no puede ser mayor que la máxima.');
    }

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
        maxCapacity,
        sortOrder: nextSort,
        ...(posX !== undefined && { posX }),
        ...(posY !== undefined && { posY }),
        ...(rotation !== undefined && { rotation: Number(rotation) }),
        ...(shape !== undefined && { shape }),
        ...(width !== undefined && { width: w }),
        ...(height !== undefined && { height: h }),
      },
    });

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.status(201).json(table);
  } catch (error) {
    next(error);
  }
});

router.put('/zone/:zoneId/reorder', async (req, res, next) => {
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

router.put('/zone/:zoneId/layout', async (req, res, next) => {
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

    const check = validateNoOverlap(merged, zone.gridCols, zone.gridRows);
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

router.patch('/:id', async (req, res, next) => {
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

    const nextMin = minCapacity !== undefined ? minCapacity : table.minCapacity;
    const nextMax = maxCapacity !== undefined ? maxCapacity : table.maxCapacity;
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
        ...(minCapacity !== undefined && { minCapacity }),
        ...(maxCapacity !== undefined && { maxCapacity }),
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

router.delete('/:id', async (req, res, next) => {
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
