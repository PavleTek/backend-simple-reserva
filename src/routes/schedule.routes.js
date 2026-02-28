const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

router.use(authenticateToken);
router.use(authenticateRoles(['owner', 'admin']));

router.get('/', async (req, res, next) => {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { restaurantId: req.user.restaurantId },
      orderBy: { dayOfWeek: 'asc' },
    });

    res.json(schedules);
  } catch (error) {
    next(error);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const entries = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('El cuerpo de la petición debe ser un array no vacío de horarios');
    }

    for (const entry of entries) {
      if (entry.dayOfWeek === undefined || !entry.openTime || !entry.closeTime) {
        throw new ValidationError('Cada entrada requiere dayOfWeek, openTime y closeTime');
      }
    }

    const schedules = await prisma.$transaction(async (tx) => {
      await tx.schedule.deleteMany({
        where: { restaurantId: req.user.restaurantId },
      });

      await tx.schedule.createMany({
        data: entries.map((entry) => ({
          restaurantId: req.user.restaurantId,
          dayOfWeek: entry.dayOfWeek,
          openTime: entry.openTime,
          closeTime: entry.closeTime,
          isActive: entry.isActive ?? true,
        })),
      });

      return tx.schedule.findMany({
        where: { restaurantId: req.user.restaurantId },
        orderBy: { dayOfWeek: 'asc' },
      });
    });

    res.json(schedules);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
