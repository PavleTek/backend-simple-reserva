const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');
const { incrementDataVersion } = require('../utils/dataVersion');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(ROLES_CONFIG));

router.get('/', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const zones = await prisma.zone.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        tables: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
      },
    });

    res.json(zones);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, description, sortOrder, smokingZone } = req.body;
    const restaurantId = req.activeRestaurant.restaurantId;

    if (!name) {
      throw new ValidationError('El nombre es obligatorio');
    }

    const canAdd = await planService.canAddZone(restaurantId, true);
    if (!canAdd.allowed) {
      throw new ValidationError(canAdd.reason || 'Límite de zonas alcanzado');
    }

    const zone = await prisma.zone.create({
      data: {
        restaurantId,
        name,
        description: description || null,
        sortOrder: sortOrder ?? 0,
        ...(smokingZone !== undefined && { smokingZone: Boolean(smokingZone) }),
      },
    });

    res.status(201).json(zone);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.id },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const { name, description, sortOrder, gridCols, gridRows, smokingZone } = req.body;

    if (name !== undefined && (!name || !String(name).trim())) {
      throw new ValidationError('El nombre no puede estar vacío');
    }

    const nextCols = gridCols !== undefined ? Number(gridCols) : zone.gridCols;
    const nextRows = gridRows !== undefined ? Number(gridRows) : zone.gridRows;
    if (
      (gridCols !== undefined && (!Number.isFinite(nextCols) || nextCols < 1 || nextCols > 50)) ||
      (gridRows !== undefined && (!Number.isFinite(nextRows) || nextRows < 1 || nextRows > 50))
    ) {
      throw new ValidationError('La grilla debe tener entre 1 y 50 filas y columnas.');
    }

    if (gridCols !== undefined || gridRows !== undefined) {
      const tables = await prisma.restaurantTable.findMany({
        where: { zoneId: zone.id, isActive: true },
      });
      const { tableFitsInGrid } = require('../lib/floorPlanUtils');
      for (const t of tables) {
        if (t.posX == null || t.posY == null) continue;
        if (!tableFitsInGrid(t, nextCols, nextRows)) {
          throw new ValidationError(
            'No se puede reducir la grilla: alguna mesa quedaría fuera del plano. Mueve las mesas primero.',
          );
        }
      }
    }

    const updated = await prisma.zone.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(gridCols !== undefined && { gridCols: nextCols }),
        ...(gridRows !== undefined && { gridRows: nextRows }),
        ...(smokingZone !== undefined && { smokingZone: Boolean(smokingZone) }),
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
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.id },
      include: { tables: { select: { id: true } } },
    });

    if (!zone || zone.restaurantId !== req.activeRestaurant.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const tableIds = zone.tables.map((t) => t.id);
    const futureCount = tableIds.length > 0
      ? await prisma.reservation.count({
          where: {
            tableId: { in: tableIds },
            status: 'confirmed',
            dateTime: { gte: new Date() },
          },
        })
      : 0;
    if (futureCount > 0) {
      throw new ValidationError(
        `No se puede eliminar la zona: tiene ${futureCount} reserva(s) futura(s) en sus mesas. Cancela o reasigna primero.`,
      );
    }

    await prisma.zone.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ message: 'Zona eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
