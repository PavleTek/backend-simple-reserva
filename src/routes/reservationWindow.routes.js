const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');
const { isReservationWindowsEnabled } = require('../lib/slotEngineFlags');

const router = express.Router({ mergeParams: true });

function requireWindowsFeature(_req, res, next) {
  if (!isReservationWindowsEnabled()) {
    return res.status(403).json({
      error: 'Las ventanas de reserva personalizadas no están habilitadas en este entorno.',
    });
  }
  next();
}

function validateWindow(startTime, endTime) {
  if (!/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) {
    throw new ValidationError('Horario inválido. Usa formato HH:mm');
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if (sh * 60 + sm >= eh * 60 + em) {
    throw new ValidationError('La hora de fin debe ser posterior a la de inicio');
  }
}

function windowsOverlap(a, b) {
  const [as, ae] = a;
  const [bs, be] = b;
  return as < be && bs < ae;
}

/**
 * GET /api/restaurant/:restaurantId/reservation-windows
 */
router.get(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const windows = await prisma.reservationWindow.findMany({
        where: { restaurantId },
        orderBy: [{ dayOfWeek: 'asc' }, { sortOrder: 'asc' }],
      });
      res.json(windows);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/restaurant/:restaurantId/reservation-windows
 * Body: { reservationWindowMode?: string, windows: Array<{ dayOfWeek, startTime, endTime, label?, sortOrder? }> }
 */
router.put(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  requireWindowsFeature,
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const { reservationWindowMode, windows } = req.body;

      if (
        reservationWindowMode !== undefined &&
        !['same_as_schedule', 'custom'].includes(reservationWindowMode)
      ) {
        throw new ValidationError('Modo de ventana de reserva no válido');
      }

      if (windows !== undefined) {
        if (!Array.isArray(windows)) {
          throw new ValidationError('windows debe ser un arreglo');
        }

        const byDay = new Map();
        for (const w of windows) {
          const day = Number(w.dayOfWeek);
          if (!Number.isInteger(day) || day < 0 || day > 6) {
            throw new ValidationError('dayOfWeek debe ser 0–6');
          }
          validateWindow(w.startTime, w.endTime);
          const startMin = w.startTime.split(':').map(Number);
          const endMin = w.endTime.split(':').map(Number);
          const range = [startMin[0] * 60 + startMin[1], endMin[0] * 60 + endMin[1]];
          if (!byDay.has(day)) byDay.set(day, []);
          const dayRanges = byDay.get(day);
          for (const existing of dayRanges) {
            if (windowsOverlap(existing, range)) {
              throw new ValidationError(
                `Ventanas solapadas el día ${day}. Ajusta los horarios.`
              );
            }
          }
          dayRanges.push(range);
        }

        await prisma.$transaction(async (tx) => {
          await tx.reservationWindow.deleteMany({ where: { restaurantId } });
          if (windows.length > 0) {
            await tx.reservationWindow.createMany({
              data: windows.map((w, i) => ({
                restaurantId,
                dayOfWeek: Number(w.dayOfWeek),
                startTime: w.startTime,
                endTime: w.endTime,
                label: w.label ?? null,
                sortOrder: w.sortOrder ?? i,
              })),
            });
          }
          if (reservationWindowMode !== undefined) {
            await tx.restaurant.update({
              where: { id: restaurantId },
              data: { reservationWindowMode },
            });
          } else if (windows.length > 0) {
            await tx.restaurant.update({
              where: { id: restaurantId },
              data: { reservationWindowMode: 'custom' },
            });
          }
        });
      } else if (reservationWindowMode !== undefined) {
        await prisma.restaurant.update({
          where: { id: restaurantId },
          data: { reservationWindowMode },
        });
      }

      const [updatedWindows, restaurant] = await Promise.all([
        prisma.reservationWindow.findMany({
          where: { restaurantId },
          orderBy: [{ dayOfWeek: 'asc' }, { sortOrder: 'asc' }],
        }),
        prisma.restaurant.findUnique({
          where: { id: restaurantId },
          select: { reservationWindowMode: true },
        }),
      ]);

      res.json({
        reservationWindowMode: restaurant?.reservationWindowMode ?? 'same_as_schedule',
        windows: updatedWindows,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
