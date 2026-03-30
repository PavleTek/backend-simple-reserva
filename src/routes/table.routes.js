const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');
const { incrementDataVersion } = require('../utils/dataVersion');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']));

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

    const { label, minCapacity, maxCapacity } = req.body;

    if (!label || maxCapacity === undefined) {
      throw new ValidationError('Se requiere label y maxCapacity');
    }

    const minC = minCapacity ?? 1;
    if (minC > maxCapacity) {
      throw new ValidationError('La capacidad mínima no puede ser mayor que la máxima.');
    }

    const lastInZone = await prisma.restaurantTable.findFirst({
      where: { zoneId: req.params.zoneId, isActive: true },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextSort = (lastInZone?.sortOrder ?? -1) + 1;

    const table = await prisma.restaurantTable.create({
      data: {
        zoneId: req.params.zoneId,
        label,
        minCapacity: minC,
        maxCapacity,
        sortOrder: nextSort,
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

router.patch('/:id', async (req, res, next) => {
  try {
    const table = await prisma.restaurantTable.findUnique({
      where: { id: req.params.id },
      include: { zone: true },
    });

    if (!table || table.zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Mesa no encontrada');
    }

    const { label, minCapacity, maxCapacity } = req.body;

    const nextMin = minCapacity !== undefined ? minCapacity : table.minCapacity;
    const nextMax = maxCapacity !== undefined ? maxCapacity : table.maxCapacity;
    if (nextMin > nextMax) {
      throw new ValidationError('La capacidad mínima no puede ser mayor que la máxima.');
    }

    const updated = await prisma.restaurantTable.update({
      where: { id: req.params.id },
      data: {
        ...(label !== undefined && { label }),
        ...(minCapacity !== undefined && { minCapacity }),
        ...(maxCapacity !== undefined && { maxCapacity }),
      },
    });

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
