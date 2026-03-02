const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['owner', 'admin']));

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
      orderBy: { label: 'asc' },
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

    const { label, minCapacity, maxCapacity } = req.body;

    if (!label || maxCapacity === undefined) {
      throw new ValidationError('Se requiere label y maxCapacity');
    }

    const table = await prisma.restaurantTable.create({
      data: {
        zoneId: req.params.zoneId,
        label,
        minCapacity: minCapacity ?? 1,
        maxCapacity,
      },
    });

    res.status(201).json(table);
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
