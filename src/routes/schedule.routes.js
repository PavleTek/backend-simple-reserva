const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG, ROLES_CONFIG_VIEW } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');
const { timeToMinutes } = require('../services/slotEngine/windows');
const { isCrossMidnightEnabled } = require('../lib/featureFlags');

/**
 * Reintenta una vez ante conflicto de transacción (Prisma P2034), típico con escrituras concurrentes.
 */
async function withTransactionConflictRetry(run) {
  try {
    return await run();
  } catch (err) {
    if (err && err.code === 'P2034') {
      await new Promise((r) => setTimeout(r, 100));
      return run();
    }
    throw err;
  }
}

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

router.get('/', authenticateRestaurantRoles(ROLES_CONFIG_VIEW), async (req, res, next) => {
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

router.put('/', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const entries = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('El cuerpo de la petición debe ser un array no vacío de horarios');
    }

    const timeRegex = /^\d{1,2}:\d{2}$/;
    const seenDayOfWeek = new Set();
    for (const entry of entries) {
      if (entry.dayOfWeek === undefined || !entry.openTime || !entry.closeTime) {
        throw new ValidationError('Cada entrada requiere dayOfWeek, openTime y closeTime');
      }
      if (seenDayOfWeek.has(entry.dayOfWeek)) {
        throw new ValidationError('Cada día de la semana debe aparecer solo una vez en el horario');
      }
      seenDayOfWeek.add(entry.dayOfWeek);
      if (entry.dayOfWeek < 0 || entry.dayOfWeek > 6) {
        throw new ValidationError('dayOfWeek debe estar entre 0 (domingo) y 6 (sábado)');
      }
      if (!timeRegex.test(entry.openTime) || !timeRegex.test(entry.closeTime)) {
        throw new ValidationError('openTime y closeTime deben tener formato HH:MM');
      }
      const closesNextDay = !!entry.closesNextDay && isCrossMidnightEnabled();
      if (!closesNextDay && entry.openTime >= entry.closeTime) {
        throw new ValidationError(
          `El horario de cierre debe ser posterior al de apertura (${entry.dayName ?? entry.dayOfWeek}). Si tu local cierra al día siguiente, activa "Cierra al día siguiente".`,
        );
      }
      if (closesNextDay) {
        const open = timeToMinutes(entry.openTime);
        const close = timeToMinutes(entry.closeTime);
        const span = close + 1440 - open;
        if (span <= 0 || span > 24 * 60) {
          throw new ValidationError(`Duración de jornada inválida (día ${entry.dayOfWeek}).`);
        }
      }

      const periodFields = [
        ['breakfastStartTime', 'breakfastEndTime', 'Desayuno', false],
        ['lunchStartTime', 'lunchEndTime', 'Almuerzo', false],
        ['dinnerStartTime', 'dinnerEndTime', 'Cena', 'dinnerEndsNextDay'],
      ];

      for (const [startKey, endKey, label, nextDayKey] of periodFields) {
        const start = entry[startKey];
        const end = entry[endKey];
        if (start || end) {
          if (!start || !end) {
            throw new ValidationError(`Ambas horas de inicio y fin son requeridas para el periodo de ${label}`);
          }
          if (!timeRegex.test(start) || !timeRegex.test(end)) {
            throw new ValidationError(`Las horas de ${label} deben tener formato HH:MM`);
          }
          const periodNextDay =
            nextDayKey === 'dinnerEndsNextDay'
              ? !!entry.dinnerEndsNextDay && isCrossMidnightEnabled()
              : false;
          if (!periodNextDay && start >= end) {
            throw new ValidationError(
              `La hora de inicio de ${label} (${start}) debe ser anterior a la de fin (${end}), o activa cierre al día siguiente.`,
            );
          }
        }
      }
    }

    const restaurantId = req.activeRestaurant.restaurantId;
    const dayOfWeeksInPayload = entries.map((e) => e.dayOfWeek);

    const schedules = await withTransactionConflictRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.schedule.deleteMany({
          where: {
            restaurantId,
            dayOfWeek: { notIn: dayOfWeeksInPayload },
          },
        });

        for (const entry of entries) {
          await tx.schedule.upsert({
            where: {
              restaurantId_dayOfWeek: {
                restaurantId,
                dayOfWeek: entry.dayOfWeek,
              },
            },
            create: {
              restaurantId,
              dayOfWeek: entry.dayOfWeek,
              openTime: entry.openTime,
              closeTime: entry.closeTime,
              closesNextDay: !!entry.closesNextDay,
              breakfastStartTime: entry.breakfastStartTime || null,
              breakfastEndTime: entry.breakfastEndTime || null,
              lunchStartTime: entry.lunchStartTime || null,
              lunchEndTime: entry.lunchEndTime || null,
              dinnerStartTime: entry.dinnerStartTime || null,
              dinnerEndTime: entry.dinnerEndTime || null,
              dinnerEndsNextDay: !!entry.dinnerEndsNextDay,
              isActive: entry.isActive ?? true,
            },
            update: {
              openTime: entry.openTime,
              closeTime: entry.closeTime,
              closesNextDay: !!entry.closesNextDay,
              breakfastStartTime: entry.breakfastStartTime || null,
              breakfastEndTime: entry.breakfastEndTime || null,
              lunchStartTime: entry.lunchStartTime || null,
              lunchEndTime: entry.lunchEndTime || null,
              dinnerStartTime: entry.dinnerStartTime || null,
              dinnerEndTime: entry.dinnerEndTime || null,
              dinnerEndsNextDay: !!entry.dinnerEndsNextDay,
              isActive: entry.isActive ?? true,
            },
          });
        }

        return tx.schedule.findMany({
          where: { restaurantId },
          orderBy: { dayOfWeek: 'asc' },
        });
      }),
    );

    res.json(schedules);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
