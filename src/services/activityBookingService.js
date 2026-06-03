'use strict';

const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { ACTIVE_ACTIVITY_BOOKING_STATUSES, canTransitionActivityBookingStatus } = require('../lib/activityBookingStatuses');
const { getRemainingCapacity, getBookedGuestsForSession } = require('./activitySessionService');
const { validateSlotForBooking } = require('./slotEngine/validate');
const { pickTable } = require('./slotEngine/capacity');
const { loadDaySnapshot } = require('./slotEngine/index');
const { getEffectiveTimezone, parseInTimezone, getDayOfWeekInTimezone } = require('../utils/timezone');
const { DateTime } = require('luxon');

const MAX_TX_RETRIES = 3;

async function runSerializable(fn) {
  let lastErr;
  for (let i = 0; i < MAX_TX_RETRIES; i++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (err) {
      lastErr = err;
      if (err.code !== 'P2034') throw err;
    }
  }
  throw lastErr;
}

function computePriceSnapshot(activity, session, partySize) {
  const pricePerPerson =
    session.pricePerPersonOverride != null
      ? Number(session.pricePerPersonOverride)
      : activity.pricePerPerson != null
        ? Number(activity.pricePerPerson)
        : null;
  const totalReferential =
    pricePerPerson != null ? Math.round(pricePerPerson * partySize * 100) / 100 : null;
  return { pricePerPerson, totalReferential };
}

async function validateSessionBooking(session, activity, partySize, now = new Date()) {
  if (session.status !== 'SCHEDULED') {
    throw new ValidationError('Esta sesión no está disponible para reservas');
  }
  if (partySize < activity.minPartySize) {
    throw new ValidationError(`El mínimo de personas es ${activity.minPartySize}`);
  }
  if (activity.maxPartySize != null && partySize > activity.maxPartySize) {
    throw new ValidationError(`El máximo de personas es ${activity.maxPartySize}`);
  }
  const noticeMs = (activity.minimumNoticeMinutes ?? 0) * 60000;
  if (session.startAt.getTime() - now.getTime() < noticeMs) {
    throw new ValidationError('No hay tiempo suficiente de anticipación para reservar');
  }
  const remaining = await getRemainingCapacity(session.id);
  if (remaining < partySize) {
    throw new ValidationError('No hay cupo suficiente en esta sesión');
  }
}

async function createActivityBooking({
  sessionId,
  partySize,
  customerName,
  customerEmail,
  customerPhone,
  notes,
  source = 'web',
  confirmedByUserId = null,
  holdToken = null,
}) {
  return runSerializable(async (tx) => {
    const session = await tx.activitySession.findUnique({
      where: { id: sessionId },
      include: { activity: { include: { zones: true } } },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const activity = session.activity;
    if (!activity || activity.isDeleted || !activity.isActive) {
      throw new ValidationError('Actividad no disponible');
    }

    if (holdToken) {
      const hold = await tx.activitySessionHold.findFirst({
        where: { holdToken, sessionId, status: 'active', expiresAt: { gt: new Date() } },
      });
      if (!hold || hold.partySize !== partySize) {
        throw new ValidationError('Hold inválido o expirado');
      }
      await tx.activitySessionHold.update({
        where: { id: hold.id },
        data: { status: 'consumed' },
      });
    }

    await validateSessionBooking(session, activity, partySize);

    const { pricePerPerson, totalReferential } = computePriceSnapshot(activity, session, partySize);
    const initialStatus = activity.requiresApproval ? 'PENDING' : 'CONFIRMED';

    let reservationId = null;

    if (activity.capacityMode === 'SHARED_TABLES') {
      const restaurant = await tx.restaurant.findUnique({ where: { id: session.restaurantId } });
      const timezone = getEffectiveTimezone(restaurant);
      const dateStr = DateTime.fromJSDate(session.startAt, { zone: 'utc' })
        .setZone(timezone)
        .toFormat('yyyy-MM-dd');
      const time = DateTime.fromJSDate(session.startAt, { zone: 'utc' })
        .setZone(timezone)
        .toFormat('HH:mm');

      const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
      const slotDateTime = parseInTimezone(dateStr, time, timezone);
      const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);

      const validation = validateSlotForBooking({
        time,
        partySize,
        schedule: snapshot.schedule,
        restaurant: { ...restaurant, ...snapshot.defaults },
        durationRules: snapshot.durationRules,
        customWindows: snapshot.reservationWindows,
        tables: snapshot.tables,
        reservations: snapshot.reservations,
        activeHolds: snapshot.activeHolds,
        blockedSlots: snapshot.blockedSlots,
        pacingRules: snapshot.pacingRules,
        slotDateTime,
        now: new Date(),
        isToday: dateStr === DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd'),
        walkIn: false,
        zoneId: activity.zones[0]?.zoneId ?? null,
        dayOfWeek,
        blockingSessions: snapshot.blockingSessions ?? [],
      });

      if (!validation.valid) {
        throw new ValidationError(`No hay mesas disponibles: ${validation.reason}`);
      }

      const parsedRes = snapshot.reservations.map((r) => ({
        tableId: r.tableId,
        start: new Date(r.startUtc),
        end: new Date(new Date(r.startUtc).getTime() + r.durationMinutes * 60000),
      }));
      const parsedHolds = snapshot.activeHolds.map((h) => ({
        tableId: h.tableId,
        start: new Date(h.startUtc),
        end: new Date(new Date(h.startUtc).getTime() + h.durationMinutes * 60000),
        holdToken: h.holdToken,
      }));
      const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
      const slotEnd = new Date(slotDateTime.getTime() + validation.durationMinutes * 60000);

      const table = pickTable(
        snapshot.tables,
        partySize,
        slotDateTime,
        slotEnd,
        bufferMs,
        parsedRes,
        parsedHolds,
        activity.zones[0]?.zoneId ?? null,
        null,
        {},
        snapshot.blockingSessions ?? []
      );

      if (!table) throw new ValidationError('No hay mesas disponibles para esta actividad');

      const reservation = await tx.reservation.create({
        data: {
          restaurantId: session.restaurantId,
          tableId: table.id,
          customerName: String(customerName).trim(),
          customerEmail: customerEmail || null,
          customerPhone: customerPhone || null,
          partySize,
          dateTime: slotDateTime,
          businessDate: session.businessDate,
          durationMinutes: validation.durationMinutes,
          status: 'confirmed',
          source: 'activity',
          notes: notes || null,
          confirmedByUserId,
        },
      });
      reservationId = reservation.id;
    }

    const booking = await tx.activityBooking.create({
      data: {
        sessionId: session.id,
        activityId: activity.id,
        restaurantId: session.restaurantId,
        customerName: String(customerName).trim(),
        customerEmail: customerEmail || null,
        customerPhone: customerPhone || null,
        partySize,
        status: initialStatus,
        notes: notes || null,
        source,
        activityName: activity.name,
        sessionStartAt: session.startAt,
        pricePerPerson,
        totalReferential,
        reservationId,
        confirmedByUserId,
      },
    });

    return booking;
  });
}

async function updateActivityBookingStatus(bookingId, restaurantId, newStatus, updatedByUserId = null) {
  return runSerializable(async (tx) => {
    const booking = await tx.activityBooking.findFirst({
      where: { id: bookingId, restaurantId },
      include: { session: { include: { activity: true } } },
    });
    if (!booking) throw new NotFoundError('Reserva de actividad no encontrada');

    if (!canTransitionActivityBookingStatus(booking.status, newStatus)) {
      throw new ValidationError(`No se puede cambiar de ${booking.status} a ${newStatus}`);
    }

    const updated = await tx.activityBooking.update({
      where: { id: bookingId },
      data: { status: newStatus, updatedByUserId },
    });

    if (booking.reservationId) {
      if (newStatus === 'CANCELLED' || newStatus === 'NO_SHOW') {
        await tx.reservation.update({
          where: { id: booking.reservationId },
          data: { status: 'cancelled', updatedByUserId },
        });
      } else if (newStatus === 'ARRIVED') {
        await tx.reservation.update({
          where: { id: booking.reservationId },
          data: { status: 'arrived', updatedByUserId },
        });
      } else if (newStatus === 'COMPLETED') {
        await tx.reservation.update({
          where: { id: booking.reservationId },
          data: { status: 'completed', updatedByUserId },
        });
      }
    }

    return updated;
  });
}

async function cancelActivityBookingByToken(secureToken) {
  const booking = await prisma.activityBooking.findUnique({ where: { secureToken } });
  if (!booking) throw new NotFoundError('Reserva no encontrada');
  if (booking.status !== 'CANCELLED') {
    await updateActivityBookingStatus(booking.id, booking.restaurantId, 'CANCELLED');
  }
  return getActivityBookingByTokenForPublic(secureToken);
}

async function getActivityBookingByTokenForPublic(secureToken) {
  const booking = await prisma.activityBooking.findUnique({
    where: { secureToken },
    include: {
      session: { select: { startAt: true, endAt: true, capacity: true, status: true } },
      activity: { select: { name: true, description: true, cancellationPolicy: true } },
    },
  });
  if (!booking) throw new NotFoundError('Reserva no encontrada');

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: booking.restaurantId },
    select: { name: true, slug: true, phone: true, address: true },
  });

  return { ...booking, restaurant };
}

async function createSessionHold(sessionId, partySize, ttlSeconds = 300) {
  return runSerializable(async (tx) => {
    const session = await tx.activitySession.findUnique({
      where: { id: sessionId },
      include: { activity: true },
    });
    if (!session || session.status !== 'SCHEDULED') {
      throw new ValidationError('Sesión no disponible');
    }
    await validateSessionBooking(session, session.activity, partySize);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return tx.activitySessionHold.create({
      data: { sessionId, partySize, expiresAt },
    });
  });
}

module.exports = {
  createActivityBooking,
  updateActivityBookingStatus,
  cancelActivityBookingByToken,
  getActivityBookingByTokenForPublic,
  createSessionHold,
  validateSessionBooking,
  computePriceSnapshot,
};
