const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']));

router.get('/', async (req, res, next) => {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { restaurantId: req.activeRestaurant.restaurantId },
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

    const timeRegex = /^\d{1,2}:\d{2}$/;
    for (const entry of entries) {
      if (entry.dayOfWeek === undefined || !entry.openTime || !entry.closeTime) {
        throw new ValidationError('Cada entrada requiere dayOfWeek, openTime y closeTime');
      }
      if (entry.dayOfWeek < 0 || entry.dayOfWeek > 6) {
        throw new ValidationError('dayOfWeek debe estar entre 0 (domingo) y 6 (sábado)');
      }
      if (!timeRegex.test(entry.openTime) || !timeRegex.test(entry.closeTime)) {
        throw new ValidationError('openTime y closeTime deben tener formato HH:MM');
      }
      if (entry.openTime >= entry.closeTime) {
        throw new ValidationError(`El horario de apertura (${entry.openTime}) debe ser anterior al de cierre (${entry.closeTime})`);
      }

      const periodFields = [
        ['breakfastStartTime', 'breakfastEndTime', 'Desayuno'],
        ['lunchStartTime', 'lunchEndTime', 'Almuerzo'],
        ['dinnerStartTime', 'dinnerEndTime', 'Cena']
      ];

      for (const [startKey, endKey, label] of periodFields) {
        const start = entry[startKey];
        const end = entry[endKey];
        if (start || end) {
          if (!start || !end) {
            throw new ValidationError(`Ambas horas de inicio y fin son requeridas para el periodo de ${label}`);
          }
          if (!timeRegex.test(start) || !timeRegex.test(end)) {
            throw new ValidationError(`Las horas de ${label} deben tener formato HH:MM`);
          }
          if (start >= end) {
            throw new ValidationError(`La hora de inicio de ${label} (${start}) debe ser anterior a la de fin (${end})`);
          }
        }
      }
    }

    const schedules = await prisma.$transaction(async (tx) => {
      await tx.schedule.deleteMany({
        where: { restaurantId: req.activeRestaurant.restaurantId },
      });

      await tx.schedule.createMany({
        data: entries.map((entry) => ({
          restaurantId: req.activeRestaurant.restaurantId,
          dayOfWeek: entry.dayOfWeek,
          openTime: entry.openTime,
          closeTime: entry.closeTime,
          breakfastStartTime: entry.breakfastStartTime || null,
          breakfastEndTime: entry.breakfastEndTime || null,
          lunchStartTime: entry.lunchStartTime || null,
          lunchEndTime: entry.lunchEndTime || null,
          dinnerStartTime: entry.dinnerStartTime || null,
          dinnerEndTime: entry.dinnerEndTime || null,
          isActive: entry.isActive ?? true,
        })),
      });

      return tx.schedule.findMany({
        where: { restaurantId: req.activeRestaurant.restaurantId },
        orderBy: { dayOfWeek: 'asc' },
      });
    });

    res.json(schedules);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
