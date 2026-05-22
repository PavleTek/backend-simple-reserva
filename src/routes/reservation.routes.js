'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const {
  loadDaySnapshot,
  getAvailabilitySlotsForRestaurant,
  findNextAvailableDateForSlug,
  validateSlotForBooking,
  resolveDuration,
} = require('../services/slotEngine/index');
const { pickTable, parseReservations, parseHolds } = require('../services/slotEngine/capacity');
const { NotFoundError, ValidationError } = require('../utils/errors');
const {
  sendReservationConfirmation,
  sendCancellationNotification,
  sendModificationAlertToCustomer,
  sendReservationConfirmationEmail,
  notifyRestaurantWaitlistEntry,
} = require('../services/notificationService');
const { canCreateReservation, canSendConfirmations, hasActiveAccess } = require('../services/subscriptionService');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  getDayOfWeekInTimezone,
} = require('../utils/timezone');
const { incrementDataVersion } = require('../utils/dataVersion');
const { incrementReservationAnalytics } = require('../services/reservationAnalyticsService');

const router = express.Router();

// ─── Helper: transacción Serializable con retry P2034 ─────────────────────────

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

// ─── Lookback dinámico para reservas ─────────────────────────────────────────

function dayLookbackMs(defaultSlotDurationMinutes, durationRules = []) {
  const maxDuration = durationRules.reduce(
    (max, r) => Math.max(max, r.durationMinutes),
    defaultSlotDurationMinutes ?? 60
  );
  return Math.max(maxDuration, 12 * 60) * 60000;
}

// ─── GET /token/:secureToken ──────────────────────────────────────────────────

router.get('/token/:secureToken', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: {
          select: {
            id: true, name: true, slug: true, address: true, shortAddress: true,
            googlePlaceId: true, latitude: true, longitude: true, phone: true,
            timezone: true,
            organization: { include: { owner: { select: { country: true } } } },
          },
        },
        table: { select: { label: true } },
      },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    const ownerCountry = reservation.restaurant.organization?.owner?.country || 'CL';
    const effectiveTimezone = getEffectiveTimezone(reservation.restaurant, ownerCountry);

    res.json({ ...reservation, restaurant: { ...reservation.restaurant, effectiveTimezone } });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /token/:secureToken — Modificar reserva (comensal) ────────────────

router.patch('/token/:secureToken', async (req, res, next) => {
  try {
    const { date, time, partySize } = req.body;
    if (!date || !time || !partySize) {
      throw new ValidationError('Se requieren date, time y partySize');
    }

    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: { include: { organization: { include: { owner: { select: { country: true } } } } } },
      },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');
    if (reservation.status !== 'confirmed') {
      throw new ValidationError('Solo se pueden modificar reservas confirmadas');
    }

    const restaurant = reservation.restaurant;
    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) throw new ValidationError('partySize debe ser un número positivo');

    const [datePart] = date.split('T');
    const dateTime = parseInTimezone(datePart, time, timezone);
    if (isNaN(dateTime.getTime())) throw new ValidationError('Formato de fecha u hora inválido');

    const now = nowInTimezone(timezone).toJSDate();
    const dayOfWeek = getDayOfWeekInTimezone(datePart, timezone);

    const updated = await withSerializableRetry(() =>
      prisma.$transaction(async (tx) => {
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

        const [durationRules, customWindows, blockedSlots, allTables, activeHolds, pacingRules] =
          await Promise.all([
            tx.durationRule.findMany({ where: { restaurantId: restaurant.id } }),
            restaurant.reservationWindowMode === 'custom'
              ? tx.reservationWindow.findMany({
                  where: { restaurantId: restaurant.id, dayOfWeek },
                  orderBy: { sortOrder: 'asc' },
                })
              : [],
            tx.blockedSlot.findMany({
              where: {
                restaurantId: restaurant.id,
                startDatetime: { lt: new Date(dateTime.getTime() + 4 * 60 * 60000) },
                endDatetime: { gt: dateTime },
              },
            }),
            tx.restaurantTable.findMany({
              where: { isActive: true, zone: { restaurantId: restaurant.id, isActive: true } },
              include: { zone: { select: { id: true, sortOrder: true } } },
            }),
            restaurant.holdsEnabled
              ? tx.reservationHold.findMany({
                  where: {
                    restaurantId: restaurant.id,
                    status: 'active',
                    expiresAt: { gt: now },
                    dateTime: {
                      gte: new Date(dateTime.getTime() - 4 * 60 * 60000),
                      lte: new Date(dateTime.getTime() + 4 * 60 * 60000),
                    },
                  },
                  select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
                })
              : [],
            tx.pacingRule.findMany({ where: { restaurantId: restaurant.id } }),
          ]);

        const lb = dayLookbackMs(restaurant.defaultSlotDurationMinutes, durationRules);
        const windowStart = new Date(dateTime.getTime() - lb);
        const windowEnd = parseInTimezone(datePart, '23:59', timezone);

        const dayReservations = await tx.reservation.findMany({
          where: {
            restaurantId: restaurant.id,
            status: 'confirmed',
            dateTime: { gte: windowStart, lte: windowEnd },
            id: { not: reservation.id },
          },
          select: { tableId: true, dateTime: true, durationMinutes: true },
        });

        const tables = allTables.map((t) => ({
          id: t.id,
          zoneId: t.zone.id,
          minCapacity: t.minCapacity,
          maxCapacity: t.maxCapacity,
          sortOrder: t.sortOrder ?? 0,
          zoneSortOrder: t.zone.sortOrder ?? 0,
          zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
        }));
        const reservationsRaw = dayReservations.map((r) => ({
          tableId: r.tableId,
          startUtc: r.dateTime.toISOString(),
          durationMinutes: r.durationMinutes,
        }));
        const holdsRaw = activeHolds.map((h) => ({
          tableId: h.tableId,
          startUtc: h.dateTime.toISOString(),
          durationMinutes: h.durationMinutes,
          holdToken: h.holdToken,
        }));
        const blockedRaw = blockedSlots.map((bs) => ({
          startUtc: bs.startDatetime.toISOString(),
          endUtc: bs.endDatetime.toISOString(),
        }));

        const validation = validateSlotForBooking({
          time,
          partySize: size,
          schedule: { ...schedule, scheduleMode: restaurant.scheduleMode },
          restaurant,
          durationRules,
          customWindows,
          tables,
          reservations: reservationsRaw,
          activeHolds: holdsRaw,
          blockedSlots: blockedRaw,
          pacingRules: pacingRules.map((p) => ({
            dayOfWeek: p.dayOfWeek, maxCoversPerSlot: p.maxCoversPerSlot, maxReservationsPerSlot: p.maxReservationsPerSlot,
          })),
          slotDateTime: dateTime,
          now,
          isToday: datePart === nowInTimezone(timezone).toFormat('yyyy-MM-dd'),
          walkIn: false,
          zoneId: null,
          excludeHoldToken: null,
          dayOfWeek,
        });

        if (!validation.valid) {
          throw new ValidationError(
            validation.reason === 'blocked' ? 'Este horario está bloqueado' :
            validation.reason === 'no_schedule' ? 'El restaurante está cerrado este día' :
            validation.reason === 'party_size_exceeds_largest_table' ? 'No hay mesas para este número de comensales' :
            'La hora solicitada no está disponible'
          );
        }

        const slotDuration = validation.durationMinutes;
        const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
        const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;

        const selectedTable = pickTable(
          tables,
          size,
          dateTime,
          slotEnd,
          bufferMs,
          parseReservations(reservationsRaw),
          parseHolds(holdsRaw),
          null,
          null
        );
        if (!selectedTable) throw new ValidationError('No hay disponibilidad en este horario');

        return tx.reservation.update({
          where: { id: reservation.id },
          data: { dateTime, partySize: size, tableId: selectedTable.id, durationMinutes: slotDuration },
          include: {
            restaurant: { select: { name: true, slug: true } },
            table: { select: { label: true } },
          },
        });
      }, { isolationLevel: 'Serializable' })
    );

    sendModificationAlertToCustomer({
      customerPhone: reservation.customerPhone,
      restaurantName: restaurant.name,
      type: 'modified',
      dateTime,
      partySize: size,
      restaurantId: restaurant.id,
    }).catch((err) => console.error('[Notification] Modification alert failed:', err));

    incrementDataVersion(restaurant.id).catch(console.error);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /token/:secureToken/cancel ────────────────────────────────────────

router.patch('/token/:secureToken/cancel', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: {
          include: { organization: { include: { owner: { select: { email: true } } } } },
        },
        table: { select: { label: true } },
      },
    });
    if (!reservation) throw new NotFoundError('Reserva no encontrada');

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: 'cancelled' },
      include: { restaurant: { select: { name: true, slug: true } }, table: { select: { label: true } } },
    });

    const panelBase = process.env.RESTAURANT_PANEL_URL || process.env.BOOKING_BASE_URL || 'http://localhost:5175';
    const panelUrl = `${panelBase.replace(/\/$/, '')}/reservations?date=${new Date(reservation.dateTime).toISOString().split('T')[0]}`;
    const emails = [...new Set(
      [reservation.restaurant?.organization?.owner?.email].filter(Boolean)
    )];
    sendCancellationNotification({
      emails,
      restaurantName: reservation.restaurant?.name || 'Restaurante',
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      dateTime: reservation.dateTime,
      partySize: reservation.partySize,
      panelUrl,
      restaurantId: reservation.restaurantId,
    }).catch((err) => console.error('[Reservation] Cancellation notification failed:', err.message));

    sendModificationAlertToCustomer({
      customerPhone: reservation.customerPhone,
      restaurantName: reservation.restaurant?.name || 'Restaurante',
      type: 'cancelled',
      restaurantId: reservation.restaurantId,
    }).catch((err) => console.error('[Notification] Cancellation alert failed:', err));

    incrementDataVersion(reservation.restaurantId).catch(console.error);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── POST / — Crear reserva pública ──────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const {
      restaurantSlug,
      date,
      time,
      partySize,
      customerName,
      customerPhone,
      customerEmail,
      notes,
      preferredZoneId,
      holdToken,
    } = req.body;

    if (!restaurantSlug || !date || !time || !partySize || !customerName) {
      throw new ValidationError('Se requiere restaurantSlug, date, time, partySize y customerName');
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) throw new ValidationError('partySize debe ser un número positivo');

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: restaurantSlug, isActive: true, isDeleted: false },
      include: { organization: { include: { owner: { select: { country: true } } } } },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const mustRequireEmail = restaurant.requireEmail ?? true;
    const mustRequirePhone = restaurant.requirePhoneNumber ?? false;
    const emailStr = typeof customerEmail === 'string' && customerEmail.trim() ? customerEmail.trim() : '';
    const phoneStr = typeof customerPhone === 'string' && customerPhone.trim() ? customerPhone.trim() : '';

    if (mustRequireEmail && !emailStr) throw new ValidationError('El correo electrónico es obligatorio');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailStr && !emailRegex.test(emailStr)) throw new ValidationError('El correo electrónico no tiene un formato válido');
    if (mustRequirePhone && !phoneStr) throw new ValidationError('El teléfono es obligatorio');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const { allowed, reason: subReason } = await canCreateReservation(restaurant.id);
    if (!allowed) throw new ValidationError(subReason);

    const dateTime = parseInTimezone(date, time, timezone);
    if (isNaN(dateTime.getTime())) throw new ValidationError('Formato de fecha u hora inválido');

    const now = nowInTimezone(timezone).toJSDate();
    const dayOfWeek = getDayOfWeekInTimezone(date, timezone);

    const reservation = await withSerializableRetry(() =>
      prisma.$transaction(async (tx) => {
        // ── Ruta con hold ─────────────────────────────────────────────────────
        if (holdToken) {
          const hold = await tx.reservationHold.findUnique({ where: { holdToken } });
          if (!hold || hold.restaurantId !== restaurant.id) {
            throw new ValidationError('Hold inválido');
          }
          if (hold.status !== 'active' || hold.expiresAt < now) {
            throw new ValidationError('El tiempo para confirmar tu reserva expiró. Por favor intenta de nuevo.');
          }
          if (hold.partySize !== size) {
            throw new ValidationError('El número de personas no coincide con el hold');
          }

          // Marcar hold como consumido
          await tx.reservationHold.update({
            where: { holdToken },
            data: { status: 'consumed' },
          });

          return tx.reservation.create({
            data: {
              restaurantId: restaurant.id,
              tableId: hold.tableId,
              customerName,
              customerPhone: phoneStr || null,
              customerEmail: emailStr ? emailStr.toLowerCase() : null,
              partySize: size,
              dateTime,
              durationMinutes: hold.durationMinutes,
              notes: notes || null,
              source: 'web',
            },
            include: {
              restaurant: { select: { name: true } },
              table: { select: { id: true, label: true } },
            },
          });
        }

        // ── Ruta sin hold (validación completa) ───────────────────────────────
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('El restaurante está cerrado este día');

        const [durationRules, customWindows, blockedSlots, allTables, activeHolds, pacingRules] =
          await Promise.all([
            tx.durationRule.findMany({ where: { restaurantId: restaurant.id } }),
            restaurant.reservationWindowMode === 'custom'
              ? tx.reservationWindow.findMany({
                  where: { restaurantId: restaurant.id, dayOfWeek },
                  orderBy: { sortOrder: 'asc' },
                })
              : [],
            tx.blockedSlot.findFirst({
              where: {
                restaurantId: restaurant.id,
                startDatetime: { lt: new Date(dateTime.getTime() + 4 * 60 * 60000) },
                endDatetime: { gt: dateTime },
              },
            }),
            tx.restaurantTable.findMany({
              where: { isActive: true, zone: { restaurantId: restaurant.id, isActive: true } },
              include: { zone: { select: { id: true, sortOrder: true } } },
            }),
            restaurant.holdsEnabled
              ? tx.reservationHold.findMany({
                  where: {
                    restaurantId: restaurant.id,
                    status: 'active',
                    expiresAt: { gt: now },
                    dateTime: {
                      gte: new Date(dateTime.getTime() - 4 * 60 * 60000),
                      lte: new Date(dateTime.getTime() + 4 * 60 * 60000),
                    },
                  },
                  select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
                })
              : [],
            tx.pacingRule.findMany({ where: { restaurantId: restaurant.id } }),
          ]);

        if (blockedSlots) {
          throw new ValidationError('Este horario está bloqueado' + (blockedSlots.reason ? ': ' + blockedSlots.reason : ''));
        }

        const lb = dayLookbackMs(restaurant.defaultSlotDurationMinutes, durationRules);
        const windowStart = new Date(dateTime.getTime() - lb);
        const windowEnd = parseInTimezone(date, '23:59', timezone);
        const dayReservations = await tx.reservation.findMany({
          where: {
            restaurantId: restaurant.id,
            status: 'confirmed',
            dateTime: { gte: windowStart, lte: windowEnd },
          },
          select: { tableId: true, dateTime: true, durationMinutes: true },
        });

        const tables = allTables.map((t) => ({
          id: t.id,
          zoneId: t.zone.id,
          minCapacity: t.minCapacity,
          maxCapacity: t.maxCapacity,
          sortOrder: t.sortOrder ?? 0,
          zoneSortOrder: t.zone.sortOrder ?? 0,
          zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
        }));
        const reservationsRaw = dayReservations.map((r) => ({
          tableId: r.tableId,
          startUtc: r.dateTime.toISOString(),
          durationMinutes: r.durationMinutes,
        }));
        const holdsRaw = activeHolds.map((h) => ({
          tableId: h.tableId,
          startUtc: h.dateTime.toISOString(),
          durationMinutes: h.durationMinutes,
          holdToken: h.holdToken,
        }));

        const validation = validateSlotForBooking({
          time,
          partySize: size,
          schedule: { ...schedule, scheduleMode: restaurant.scheduleMode },
          restaurant,
          durationRules,
          customWindows,
          tables,
          reservations: reservationsRaw,
          activeHolds: holdsRaw,
          blockedSlots: [],
          pacingRules: pacingRules.map((p) => ({
            dayOfWeek: p.dayOfWeek, maxCoversPerSlot: p.maxCoversPerSlot, maxReservationsPerSlot: p.maxReservationsPerSlot,
          })),
          slotDateTime: dateTime,
          now,
          isToday: date === nowInTimezone(timezone).toFormat('yyyy-MM-dd'),
          walkIn: false,
          zoneId: null,
          excludeHoldToken: null,
          dayOfWeek,
        });

        if (!validation.valid) {
          const msgs = {
            no_schedule: 'El restaurante está cerrado este día',
            slot_not_on_grid: 'La hora solicitada no está disponible',
            blocked: 'Este horario está bloqueado',
            party_size_exceeds_largest_table: 'No hay una mesa para este número de comensales. Contáctanos directamente.',
            no_tables_in_zone: 'No hay mesas disponibles en esa zona para este grupo',
            no_tables_available: 'No hay mesas disponibles en este horario',
            pacing_covers_exceeded: 'El cupo de este horario está completo',
            pacing_reservations_exceeded: 'Se alcanzó el límite de reservas para este horario',
          };
          throw new ValidationError(msgs[validation.reason] || 'La hora solicitada no está disponible');
        }

        const slotDuration = validation.durationMinutes;
        const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
        const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
        const zonePref = typeof preferredZoneId === 'string' && preferredZoneId.trim() ? preferredZoneId.trim() : null;

        const selectedTable = pickTable(
          tables,
          size,
          dateTime,
          slotEnd,
          bufferMs,
          parseReservations(reservationsRaw),
          parseHolds(holdsRaw),
          zonePref,
          null
        );
        if (!selectedTable) throw new ValidationError('No hay mesas disponibles en este horario');

        return tx.reservation.create({
          data: {
            restaurantId: restaurant.id,
            tableId: selectedTable.id,
            customerName,
            customerPhone: phoneStr || null,
            customerEmail: emailStr ? emailStr.toLowerCase() : null,
            partySize: size,
            dateTime,
            durationMinutes: slotDuration,
            notes: notes || null,
            source: 'web',
          },
          include: {
            restaurant: { select: { name: true } },
            table: { select: { id: true, label: true } },
          },
        });
      }, { isolationLevel: 'Serializable' })
    );

    canSendConfirmations(restaurant.id).then((ok) => {
      if (ok) {
        if (reservation.customerPhone) {
          sendReservationConfirmation({
            customerPhone: reservation.customerPhone,
            restaurantName: reservation.restaurant.name,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
            restaurantId: restaurant.id,
          }).catch((err) => console.error('[Notification] Confirmation failed:', err));
        }
        if (reservation.customerEmail) {
          sendReservationConfirmationEmail({
            customerEmail: reservation.customerEmail,
            restaurantName: reservation.restaurant.name,
            customerName,
            dateTime: reservation.dateTime,
            partySize: size,
            secureToken: reservation.secureToken,
            timezone,
          }).then((sent) => {
            if (sent) {
              prisma.reservation.update({ where: { id: reservation.id }, data: { emailSent: true } })
                .catch((err) => console.error('[Notification] emailSent update failed:', err));
            }
          }).catch((err) => console.error('[Notification] Email confirmation failed:', err));
        }
      }
    });

    incrementDataVersion(restaurant.id).catch(console.error);
    incrementReservationAnalytics(restaurant.id, restaurant.organizationId, new Date())
      .catch((err) => console.error('[ReservationAnalytics] Error:', err));

    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

// ─── GET /:slug/next-available ────────────────────────────────────────────────

router.get('/:slug/next-available', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date, partySize, zoneId } = req.query;
    if (!date || !partySize) throw new ValidationError('Se requieren los parámetros date y partySize');

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) throw new ValidationError('partySize debe ser un número positivo');

    const found = await findNextAvailableDateForSlug(slug, { fromDateStr: date, partySize: size, zoneId: zoneId || null });
    if (!found.ok) throw new NotFoundError('Restaurante no encontrado');
    if (found.reason === 'subscription_expired') return res.json({ nextDate: null, reason: 'subscription_expired' });
    if (found.nextDate) return res.json({ nextDate: found.nextDate, slotsCount: found.slotsCount });
    return res.json({ nextDate: null, reason: found.reason || 'no_future_availability' });
  } catch (err) {
    next(err);
  }
});

// ─── POST /:slug/waitlist ─────────────────────────────────────────────────────

router.post('/:slug/waitlist', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { partySize, preferredDate, customerName, customerPhone, customerEmail, notes } = req.body || {};

    const size = parseInt(partySize, 10);
    if (isNaN(size) || size < 1) throw new ValidationError('partySize debe ser un número positivo');
    const name = typeof customerName === 'string' ? customerName.trim() : '';
    const phone = typeof customerPhone === 'string' ? customerPhone.trim() : '';
    if (!name || name.length < 2) throw new ValidationError('Indica tu nombre');
    if (!phone || phone.length < 8) throw new ValidationError('Indica un teléfono de contacto');

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true, isDeleted: false },
      include: { organization: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) throw new ValidationError('Este restaurante no acepta solicitudes en este momento');

    const entry = await prisma.bookingWaitlistEntry.create({
      data: {
        restaurantId: restaurant.id,
        partySize: size,
        preferredDate: typeof preferredDate === 'string' && preferredDate ? preferredDate : null,
        customerName: name,
        customerPhone: phone,
        customerEmail: typeof customerEmail === 'string' && customerEmail.trim() ? customerEmail.trim() : null,
        notes: typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 500) : null,
      },
    });

    notifyRestaurantWaitlistEntry(restaurant, entry).catch((err) =>
      console.error('[Waitlist] notify error:', err.message)
    );

    res.status(201).json({ id: entry.id, message: 'Recibimos tu solicitud. El restaurante puede contactarte.' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:slug/day-snapshot ──────────────────────────────────────────────────

router.get('/:slug/day-snapshot', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date } = req.query;
    if (!date) throw new ValidationError('Se requiere el parámetro date');

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true, isDeleted: false },
      include: { organization: { include: { owner: { select: { country: true } } } } },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) {
      return res.json({
        date, timezone, subscriptionActive: false, schedule: null, defaults: null,
        durationRules: [], tables: [], zones: [], blockedSlots: [], reservations: [],
        serverNowUtc: new Date().toISOString(), isToday: false,
      });
    }

    const snapshot = await loadDaySnapshot(restaurant, { dateStr: date, timezone });
    return res.json({ ...snapshot, subscriptionActive: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:slug/availability ──────────────────────────────────────────────────

router.get('/:slug/availability', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date, partySize, zoneId } = req.query;
    if (!date || !partySize) throw new ValidationError('Se requieren los parámetros date y partySize');

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) throw new ValidationError('partySize debe ser un número positivo');

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true, isDeleted: false },
      include: { organization: { include: { owner: { select: { country: true } } } } },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const access = await hasActiveAccess(restaurant.organizationId);
    if (!access) return res.json({ slots: [], reason: 'subscription_expired' });

    const result = await getAvailabilitySlotsForRestaurant(restaurant, {
      dateStr: date, partySize: size, zoneId: zoneId || null, timezone,
    });

    if (result.slots.length > 0) return res.json({ slots: result.slots });
    return res.json({ slots: [], reason: result.reason || 'no_availability' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:slug — Datos públicos del restaurante ──────────────────────────────

router.get('/:slug', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: req.params.slug, isDeleted: false },
      select: {
        id: true, name: true, description: true, address: true, shortAddress: true,
        googlePlaceId: true, latitude: true, longitude: true, phone: true, email: true,
        menuPdfUrl: true, logoUrl: true, advanceBookingLimitDays: true, minimumNoticeMinutes: true,
        requireEmail: true, requirePhoneNumber: true, timezone: true, organizationId: true,
        holdsEnabled: true, holdTtlSeconds: true,
        organization: { include: { owner: { select: { country: true } } } },
        zones: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true, name: true, smokingZone: true, petFriendly: true,
            tables: { where: { isActive: true }, select: { id: true, label: true, minCapacity: true, maxCapacity: true } },
          },
        },
        schedules: { where: { isActive: true }, select: { dayOfWeek: true } },
      },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const effectiveTimezone = getEffectiveTimezone(restaurant, ownerCountry);
    const access = await hasActiveAccess(restaurant.organizationId);
    const activeDays = [...new Set(restaurant.schedules.map((s) => s.dayOfWeek))];
    const { schedules, organization, ...rest } = restaurant;

    res.json({
      ...rest,
      activeDays,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays ?? 30,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes ?? 60,
      requireEmail: restaurant.requireEmail ?? true,
      requirePhoneNumber: restaurant.requirePhoneNumber ?? false,
      bookingEnabled: access,
      effectiveTimezone,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Menu endpoints ───────────────────────────────────────────────────────────

router.get('/:slug/menus', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: req.params.slug, isDeleted: false },
      select: { id: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');
    const menus = await prisma.restaurantMenu.findMany({
      where: { restaurantId: restaurant.id },
      select: { menuType: true, url: true },
    });
    res.json(menus);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/menu/:menuType', async (req, res, next) => {
  try {
    const { slug, menuType } = req.params;
    const restaurant = await prisma.restaurant.findUnique({ where: { slug, isDeleted: false }, select: { id: true } });
    if (!restaurant) throw new NotFoundError('Restaurante no encontrado');
    const menu = await prisma.restaurantMenu.findUnique({
      where: { restaurantId_menuType: { restaurantId: restaurant.id, menuType } },
    });
    if (!menu) throw new NotFoundError('Menú no encontrado');
    if (process.env.R2_PUBLIC_URL) {
      const publicUrl = require('../services/r2Service').getPublicUrl(menu.r2Key);
      if (publicUrl) return res.redirect(302, publicUrl);
    }
    const r2Service = require('../services/r2Service');
    const stream = await r2Service.getFileStream(menu.r2Key);
    res.setHeader('Content-Type', 'application/pdf');
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/id/:restaurantId/menu/:menuType', async (req, res, next) => {
  try {
    const { restaurantId, menuType } = req.params;
    const menu = await prisma.restaurantMenu.findUnique({
      where: { restaurantId_menuType: { restaurantId, menuType } },
    });
    if (!menu) throw new NotFoundError('Menú no encontrado');
    const r2Service = require('../services/r2Service');
    const stream = await r2Service.getFileStream(menu.r2Key);
    res.setHeader('Content-Type', 'application/pdf');
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
