'use strict';

/**
 * reservationWindow.routes.js
 *
 * Gestión de ventanas de reserva por día.
 * Disponible para todos los restaurantes (sin feature flag).
 */

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');
const { getOperatingWindows, findWindowsOutsideOperating, timeToMinutes } = require('../services/slotEngine/windows');

const router = express.Router({ mergeParams: true });

function validateWindow(startTime, endTime) {
  if (!/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) {
    throw new ValidationError('Horario inválido. Usa formato HH:mm');
  }
  const s = timeToMinutes(startTime);
  const e = timeToMinutes(endTime);
  if (s >= e) {
    throw new ValidationError('La hora de fin debe ser posterior a la de inicio');
  }
}

function windowsOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1];
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
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/restaurant/:restaurantId/reservation-windows
 * Body: { reservationWindowMode?, windows: Array<{ dayOfWeek, startTime, endTime, label?, sortOrder? }> }
 *
 * Validaciones:
 * 1. No hay ventanas solapadas dentro del mismo día.
 * 2. Las ventanas custom deben estar contenidas dentro del horario operativo del día.
 */
router.put(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
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

        // Cargar horarios operativos para validar contención
        const restaurant = await prisma.restaurant.findUnique({
          where: { id: restaurantId },
          select: { scheduleMode: true },
        });
        const schedules = await prisma.schedule.findMany({
          where: { restaurantId, isActive: true },
        });

        const byDay = new Map();
        for (const w of windows) {
          const day = Number(w.dayOfWeek);
          if (!Number.isInteger(day) || day < 0 || day > 6) {
            throw new ValidationError('dayOfWeek debe ser 0–6');
          }
          validateWindow(w.startTime, w.endTime);
          const s = timeToMinutes(w.startTime);
          const e = timeToMinutes(w.endTime);
          const range = [s, e];

          if (!byDay.has(day)) byDay.set(day, []);
          const dayRanges = byDay.get(day);

          // Verificar no overlap con ventanas del mismo día ya procesadas
          for (const existing of dayRanges) {
            if (windowsOverlap(existing, range)) {
              throw new ValidationError(`Ventanas solapadas el día ${day}. Ajusta los horarios.`);
            }
          }
          dayRanges.push(range);

          // Verificar contención dentro del horario operativo del día
          const schedule = schedules.find((sc) => sc.dayOfWeek === day);
          if (schedule) {
            const opWindows = getOperatingWindows(schedule, restaurant?.scheduleMode ?? 'continuous');
            const outside = findWindowsOutsideOperating(opWindows, [range]);
            if (outside.length > 0) {
              throw new ValidationError(
                `La ventana del día ${day} (${w.startTime}–${w.endTime}) está fuera del horario de operación.`
              );
            }
          }
        }

        const shouldReplaceWindows =
          reservationWindowMode === 'custom' ||
          (reservationWindowMode === undefined && windows.length > 0);

        await prisma.$transaction(async (tx) => {
          if (shouldReplaceWindows) {
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
          }
          if (reservationWindowMode !== undefined) {
            await tx.restaurant.update({ where: { id: restaurantId }, data: { reservationWindowMode } });
          } else if (windows.length > 0) {
            await tx.restaurant.update({ where: { id: restaurantId }, data: { reservationWindowMode: 'custom' } });
          }
        });
      } else if (reservationWindowMode !== undefined) {
        await prisma.restaurant.update({ where: { id: restaurantId }, data: { reservationWindowMode } });
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
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
