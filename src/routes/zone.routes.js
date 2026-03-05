const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { NotFoundError, ValidationError } = require('../utils/errors');
const planService = require('../services/planService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']));

router.get('/', async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const zones = await prisma.zone.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        tables: {
          where: { isActive: true },
          orderBy: { label: 'asc' },
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
    const { name, description, sortOrder } = req.body;
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

    const { name, description, sortOrder } = req.body;

    if (name !== undefined && (!name || !String(name).trim())) {
      throw new ValidationError('El nombre no puede estar vacío');
    }

    const updated = await prisma.zone.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });

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
