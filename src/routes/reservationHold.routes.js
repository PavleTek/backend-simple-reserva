'use strict';

/**
 * reservationHold.routes.js
 *
 * Endpoints del sistema de holds (soft-locks temporales de cupos durante el checkout).
 *
 * POST /api/public/restaurants/:slug/reservation-holds
 *   Crea un hold para un slot. TX Serializable para garantizar atomicidad.
 *   Retorna: { holdToken, expiresAt, durationMinutes, tableId }
 *
 * DELETE /api/public/reservation-holds/:holdToken
 *   Libera un hold explícitamente (usuario hace "atrás" o cierra tab).
 *   Idempotente.
 *
 * GET /api/restaurant/:restaurantId/holds?date=YYYY-MM-DD
 *   Staff: lista holds activos del día (para mostrar "alguien está reservando ahora").
 */

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError, NotFoundError } = require('../utils/errors');
const {
  getEffectiveTimezone,
  parseInTimezone,
  getDayOfWeekInTimezone,
  nowInTimezone,
} = require('../utils/timezone');
const { hasActiveAccess } = require('../services/subscriptionService');
const {
  loadDaySnapshot,
  validateSlotForBooking,
  resolveDuration,
} = require('../services/slotEngine/index');
const { pickTable, parseReservations, parseHolds } = require('../services/slotEngine/capacity');

// Router para /api/public/restaurants/:slug/reservation-holds (POST)
const publicRestaurantRouter = express.Router();
// Router para /api/public/reservation-holds/:holdToken (DELETE)
const publicHoldRouter = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function withSerializableRetry(fn, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'P2034' && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ─── POST /api/public/restaurants/:slug/reservation-holds ────────────────────

publicRestaurantRouter.post('/:slug/reservation-holds', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date, time, partySize, zoneId, sessionId } = req.body;

    if (!date || !time || !partySize) {
      throw new ValidationError('Se requieren date, time y partySize');
    }

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize debe ser un número positivo');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true, isDeleted: false },
      include: { organization: { include: { owner: { select: { country: true } } } } },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    if (!restaurant.holdsEnabled) {
      return res.status(404).json({ error: 'Holds no habilitados en este restaurante' });
    }

    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) throw new ValidationError('Restaurante sin suscripción activa');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);
    const dateTime = parseInTimezone(date, time, timezone);
    if (isNaN(dateTime.getTime())) throw new ValidationError('Fecha u hora inválida');

    const dayOfWeek = getDayOfWeekInTimezone(date, timezone);
    const now = nowInTimezone(timezone).toJSDate();
    const ttlMs = (restaurant.holdTtlSeconds ?? 300) * 1000;

    const hold = await withSerializableRetry(async () => {
      return prisma.$transaction(async (tx) => {
        // Liberar holds anteriores del mismo sessionId en este restaurante
        if (sessionId) {
          await tx.reservationHold.updateMany({
            where: {
              restaurantId: restaurant.id,
              sessionId,
              status: 'active',
            },
            data: { status: 'released' },
          });
        }

        const snapshot = await loadDaySnapshot(restaurant, { dateStr: date, timezone });

        const durationRules = snapshot.durationRules;
        const tables = snapshot.tables;
        const reservations = snapshot.reservations;
        const activeHolds = snapshot.activeHolds;
        const blockedSlots = snapshot.blockedSlots;
        const pacingRules = snapshot.pacingRules;
        const schedule = snapshot.schedule;

        const validation = validateSlotForBooking({
          time,
          partySize: size,
          schedule,
          restaurant,
          durationRules,
          customWindows: snapshot.reservationWindows,
          tables,
          reservations,
          activeHolds,
          blockedSlots,
          pacingRules,
          slotDateTime: dateTime,
          now,
          isToday: snapshot.isToday,
          walkIn: false,
          zoneId: zoneId || null,
          excludeHoldToken: null,
          dayOfWeek,
        });

        if (!validation.valid) {
          const messages = {
            no_schedule: 'El restaurante está cerrado este día',
            slot_not_on_grid: 'Este horario no está disponible para reservar',
            blocked: 'Este horario está bloqueado',
            party_size_exceeds_largest_table: 'No hay una mesa para este número de comensales',
            no_tables_in_zone: 'No hay mesas disponibles en esa zona para este grupo',
            no_tables_available: 'No hay disponibilidad en este horario',
            pacing_covers_exceeded: 'El cupo de este horario está completo',
            pacing_reservations_exceeded: 'Se alcanzó el límite de reservas para este horario',
          };
          throw new ValidationError(
            messages[validation.reason] || 'Este horario no está disponible'
          );
        }

        const durationMinutes = validation.durationMinutes;
        const slotEnd = new Date(dateTime.getTime() + durationMinutes * 60000);
        const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;

        // Seleccionar mesa (misma lógica que pickAutoTable)
        const parsedRes = parseReservations(reservations);
        const parsedHoldsArr = parseHolds(activeHolds);
        const table = pickTable(
          tables.map((t) => ({ ...t, zone: { id: t.zoneId, sortOrder: t.zoneSortOrder ?? 0 } })),
          size,
          dateTime,
          slotEnd,
          bufferMs,
          parsedRes,
          parsedHoldsArr,
          zoneId || null,
          null
        );

        if (!table) {
          throw new ValidationError('No hay disponibilidad en este horario');
        }

        const expiresAt = new Date(now.getTime() + ttlMs);

        return tx.reservationHold.create({
          data: {
            restaurantId: restaurant.id,
            tableId: table.id,
            partySize: size,
            dateTime,
            durationMinutes,
            expiresAt,
            sessionId: typeof sessionId === 'string' ? sessionId : null,
            source: 'web',
            status: 'active',
          },
        });
      }, { isolationLevel: 'Serializable' });
    });

    res.status(201).json({
      holdToken: hold.holdToken,
      expiresAt: hold.expiresAt.toISOString(),
      durationMinutes: hold.durationMinutes,
      tableId: hold.tableId,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/public/reservation-holds/:holdToken ─────────────────────────

publicHoldRouter.delete('/:holdToken', async (req, res, next) => {
  try {
    const { holdToken } = req.params;
    await prisma.reservationHold.updateMany({
      where: { holdToken, status: 'active' },
      data: { status: 'released' },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/restaurant/:restaurantId/holds (staff) ─────────────────────────

const staffRouter = express.Router({ mergeParams: true });

staffRouter.get(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  async (req, res, next) => {
    try {
      const restaurantId = req.activeRestaurant.restaurantId;
      const { date } = req.query;

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: { organization: { include: { owner: { select: { country: true } } } } },
        select: { id: true, timezone: true, organization: true },
      });

      const ownerCountry = restaurant?.organization?.owner?.country || 'CL';
      const timezone = getEffectiveTimezone(restaurant, ownerCountry);

      const now = new Date();

      const where = {
        restaurantId,
        status: 'active',
        expiresAt: { gt: now },
      };

      if (date) {
        const dayStart = parseInTimezone(date, '00:00', timezone);
        const dayEnd = parseInTimezone(date, '23:59', timezone);
        where.dateTime = { gte: dayStart, lte: dayEnd };
      }

      const holds = await prisma.reservationHold.findMany({
        where,
        select: {
          holdToken: true,
          partySize: true,
          dateTime: true,
          durationMinutes: true,
          expiresAt: true,
          sessionId: true,
          tableId: true,
        },
        orderBy: { dateTime: 'asc' },
      });

      res.json(holds);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { publicRestaurantRouter, publicHoldRouter, staffRouter };
