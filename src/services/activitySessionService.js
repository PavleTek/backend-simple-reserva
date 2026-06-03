'use strict';

const { DateTime } = require('luxon');
const prisma = require('../lib/prisma');
const { ACTIVE_ACTIVITY_BOOKING_STATUSES } = require('../lib/activityBookingStatuses');
const { ValidationError } = require('../utils/errors');

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeSessionTime(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  if (HHMM_RE.test(trimmed)) {
    const [h, m] = trimmed.split(':');
    return `${String(parseInt(h, 10)).padStart(2, '0')}:${m}`;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 3) {
    const h = parseInt(digits.slice(0, 1), 10);
    const m = parseInt(digits.slice(1), 10);
    if (h <= 23 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  if (digits.length === 4) {
    const h = parseInt(digits.slice(0, 2), 10);
    const m = parseInt(digits.slice(2), 10);
    if (h <= 23 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  return null;
}

function parseSessionDateTime(dateStr, timeStr, timezone) {
  const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'yyyy-MM-dd HH:mm', { zone: timezone });
  if (!dt.isValid) throw new ValidationError('Fecha u hora inválida');
  return dt;
}

function sessionSlotKey(dateStr, timeStr) {
  return `${dateStr}|${timeStr}`;
}

function existingSessionSlotKey(session, timezone) {
  const dateStr = DateTime.fromJSDate(session.businessDate, { zone: timezone }).toFormat('yyyy-MM-dd');
  const timeStr = DateTime.fromJSDate(session.startAt, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm');
  return sessionSlotKey(dateStr, timeStr);
}

/**
 * Decide acción bulk por slot existente.
 * Solo SCHEDULED bloquea: COMPLETED es histórico y CANCELLED se reactiva.
 */
function resolveBulkSlotAction(existing, skipExisting) {
  if (!skipExisting || !existing) return 'create';
  if (existing.status === 'SCHEDULED') return 'skip';
  if (existing.status === 'CANCELLED') return 'reactivate';
  return 'create';
}

function enumerateSessionDates(fromStr, toStr, timezone) {
  const dates = [];
  let cur = DateTime.fromISO(fromStr, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(toStr, { zone: timezone }).startOf('day');
  if (!cur.isValid || !end.isValid || cur > end) return dates;
  while (cur <= end) {
    dates.push(cur.toFormat('yyyy-MM-dd'));
    cur = cur.plus({ days: 1 });
  }
  return dates;
}

async function getBookedGuestsForSession(sessionId, tx = prisma) {
  const agg = await tx.activityBooking.aggregate({
    where: { sessionId, status: { in: ACTIVE_ACTIVITY_BOOKING_STATUSES } },
    _sum: { partySize: true },
  });
  return agg._sum.partySize ?? 0;
}

async function getBookedGuestsBySessionIds(sessionIds, tx = prisma) {
  if (!sessionIds.length) return new Map();
  const rows = await tx.activityBooking.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds }, status: { in: ACTIVE_ACTIVITY_BOOKING_STATUSES } },
    _sum: { partySize: true },
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.sessionId, row._sum.partySize ?? 0);
  }
  return map;
}

async function getHeldGuestsForSession(sessionId, tx = prisma) {
  const now = new Date();
  const holds = await tx.activitySessionHold.findMany({
    where: { sessionId, status: 'active', expiresAt: { gt: now } },
    select: { partySize: true },
  });
  return holds.reduce((sum, h) => sum + h.partySize, 0);
}

async function getRemainingCapacity(sessionId, tx = prisma) {
  const session = await tx.activitySession.findUnique({
    where: { id: sessionId },
    select: { capacity: true, status: true },
  });
  if (!session || session.status !== 'SCHEDULED') return 0;
  const booked = await getBookedGuestsForSession(sessionId, tx);
  const held = await getHeldGuestsForSession(sessionId, tx);
  return Math.max(0, session.capacity - booked - held);
}

function buildExistingSessionMap(existingSessions, timezone) {
  const map = new Map();
  for (const session of existingSessions) {
    const key = existingSessionSlotKey(session, timezone);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, session);
      continue;
    }
    const rank = (s) => {
      if (s.status === 'SCHEDULED') return 3;
      if (s.status === 'CANCELLED') return 2;
      if (s.status === 'COMPLETED') return 1;
      return 0;
    };
    if (rank(session) > rank(prev)) {
      map.set(key, session);
    }
  }
  return map;
}

/**
 * Crea una sesión o un lote de sesiones (filas reales editables).
 */
async function createSessions(activity, payload, timezone) {
  const { single, bulk } = payload;
  if (bulk) {
    const { fromDate, toDate, times, capacity, skipExisting = true } = bulk;
    if (!fromDate || !toDate || !Array.isArray(times) || times.length === 0) {
      throw new ValidationError('Bulk requiere fromDate, toDate y times[]');
    }

    const normalizedTimes = [
      ...new Set(
        times
          .map((t) => normalizeSessionTime(t))
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));

    if (normalizedTimes.length === 0) {
      throw new ValidationError('Indica al menos un horario válido (formato 24 h, ej. 12:30)');
    }

    const cap = capacity ?? activity.defaultCapacity;
    if (!cap || cap < 1) throw new ValidationError('Indica la capacidad de la sesión');

    const dates = enumerateSessionDates(fromDate, toDate, timezone);
    if (dates.length === 0) {
      throw new ValidationError('Rango de fechas inválido');
    }

    const slots = [];
    for (const dateStr of dates) {
      for (const timeStr of normalizedTimes) {
        const startDt = parseSessionDateTime(dateStr, timeStr, timezone);
        const endDt = startDt.plus({ minutes: activity.defaultDurationMinutes });
        slots.push({
          key: sessionSlotKey(dateStr, timeStr),
          startAt: startDt.toUTC().toJSDate(),
          endAt: endDt.toUTC().toJSDate(),
          businessDate: DateTime.fromISO(dateStr, { zone: timezone }).startOf('day').toJSDate(),
        });
      }
    }

    const businessDateStart = DateTime.fromISO(dates[0], { zone: timezone }).startOf('day').toJSDate();
    const businessDateEnd = DateTime.fromISO(dates[dates.length - 1], { zone: timezone }).startOf('day').toJSDate();

    const existingSessions = await prisma.activitySession.findMany({
      where: {
        activityId: activity.id,
        businessDate: { gte: businessDateStart, lte: businessDateEnd },
      },
    });
    const existingByKey = buildExistingSessionMap(existingSessions, timezone);

    const summary = {
      requested: slots.length,
      created: 0,
      reactivated: 0,
      skippedExisting: 0,
      skippedBlocked: 0,
    };

    return prisma.$transaction(async (tx) => {
      const rowsToCreate = [];
      const reactivatedIds = [];

      for (const slot of slots) {
        const existing = existingByKey.get(slot.key);
        const action = resolveBulkSlotAction(existing, skipExisting);

        if (action === 'skip') {
          summary.skippedExisting++;
          continue;
        }

        if (action === 'reactivate') {
          await tx.activitySession.update({
            where: { id: existing.id },
            data: {
              status: 'SCHEDULED',
              capacity: cap,
              startAt: slot.startAt,
              endAt: slot.endAt,
              businessDate: slot.businessDate,
            },
          });
          reactivatedIds.push(existing.id);
          summary.reactivated++;
          continue;
        }

        rowsToCreate.push({
          activityId: activity.id,
          restaurantId: activity.restaurantId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          businessDate: slot.businessDate,
          capacity: cap,
        });
      }

      let created = [];
      if (rowsToCreate.length > 0) {
        created = await tx.activitySession.createManyAndReturn({ data: rowsToCreate });
        summary.created = created.length;
      }

      const reactivated =
        reactivatedIds.length > 0
          ? await tx.activitySession.findMany({
              where: { id: { in: reactivatedIds } },
              orderBy: { startAt: 'asc' },
            })
          : [];

      const sessions = [...created, ...reactivated].sort((a, b) => a.startAt - b.startAt);
      return { sessions, summary };
    });
  }

  if (!single) throw new ValidationError('Indica single o bulk');
  const { date, startTime, endTime, capacity, pricePerPersonOverride, notes } = single;
  if (!date || !startTime) throw new ValidationError('Fecha y hora de inicio son obligatorias');
  const cap = capacity ?? activity.defaultCapacity;
  if (!cap || cap < 1) throw new ValidationError('Indica la capacidad de la sesión');

  const normalizedStart = normalizeSessionTime(startTime);
  if (!normalizedStart) throw new ValidationError('Hora de inicio inválida');

  const startDt = parseSessionDateTime(date, normalizedStart, timezone);
  let endDt;
  if (endTime) {
    const normalizedEnd = normalizeSessionTime(endTime);
    if (!normalizedEnd) throw new ValidationError('Hora de término inválida');
    endDt = parseSessionDateTime(date, normalizedEnd, timezone);
    if (endDt <= startDt) endDt = endDt.plus({ days: 1 });
  } else {
    endDt = startDt.plus({ minutes: activity.defaultDurationMinutes });
  }

  const session = await prisma.activitySession.create({
    data: {
      activityId: activity.id,
      restaurantId: activity.restaurantId,
      startAt: startDt.toUTC().toJSDate(),
      endAt: endDt.toUTC().toJSDate(),
      businessDate: DateTime.fromISO(date, { zone: timezone }).startOf('day').toJSDate(),
      capacity: cap,
      pricePerPersonOverride: pricePerPersonOverride != null ? parseFloat(pricePerPersonOverride) : null,
      notes: notes || null,
    },
  });

  return session;
}

async function listSessionsWithAvailability(activityId, { from, to, minimumNoticeMinutes } = {}) {
  const where = { activityId, status: 'SCHEDULED' };
  if (from || to) {
    where.startAt = {};
    if (from) where.startAt.gte = new Date(from);
    if (to) where.startAt.lte = new Date(to);
  }

  const sessions = await prisma.activitySession.findMany({
    where,
    orderBy: { startAt: 'asc' },
  });

  const noticeMs = (minimumNoticeMinutes ?? 0) * 60000;
  const now = Date.now();

  const result = [];
  for (const session of sessions) {
    if (minimumNoticeMinutes != null && minimumNoticeMinutes > 0) {
      if (session.startAt.getTime() - now < noticeMs) continue;
    }
    const bookedGuests = await getBookedGuestsForSession(session.id);
    const heldGuests = await getHeldGuestsForSession(session.id);
    const remainingCapacity = Math.max(0, session.capacity - bookedGuests - heldGuests);
    result.push({
      ...session,
      bookedGuests,
      heldGuests,
      remainingCapacity,
      isSoldOut: remainingCapacity <= 0,
    });
  }
  return result;
}

async function loadBlockingSessionsForDay(restaurantId, dayStart, dayEnd) {
  const sessions = await prisma.activitySession.findMany({
    where: {
      restaurantId,
      status: 'SCHEDULED',
      startAt: { lte: dayEnd },
      endAt: { gte: dayStart },
      activity: { capacityMode: 'BLOCKS_VENUE', isActive: true, isDeleted: false },
    },
    include: {
      activity: {
        include: { zones: { select: { zoneId: true } } },
      },
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    startAt: s.startAt,
    endAt: s.endAt,
    blockScope: s.activity.blockScope,
    zoneIds: s.activity.zones.map((z) => z.zoneId),
  }));
}

module.exports = {
  createSessions,
  listSessionsWithAvailability,
  getRemainingCapacity,
  getBookedGuestsForSession,
  getHeldGuestsForSession,
  loadBlockingSessionsForDay,
  parseSessionDateTime,
  normalizeSessionTime,
  enumerateSessionDates,
  sessionSlotKey,
  existingSessionSlotKey,
  resolveBulkSlotAction,
};
