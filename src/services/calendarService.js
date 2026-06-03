'use strict';

const prisma = require('../lib/prisma');
const { DateTime } = require('luxon');
const { getEffectiveTimezone } = require('../utils/timezone');
const { buildServiceView } = require('./serviceView');
const { ACTIVE_ACTIVITY_BOOKING_STATUSES } = require('../lib/activityBookingStatuses');

async function buildActivityDay(restaurantId, dateStr) {
  const sessions = await prisma.activitySession.findMany({
    where: {
      restaurantId,
      businessDate: new Date(dateStr),
      status: { in: ['SCHEDULED', 'COMPLETED'] },
    },
    include: {
      activity: { select: { id: true, name: true, category: true, capacityMode: true } },
      bookings: {
        where: { status: { in: ACTIVE_ACTIVITY_BOOKING_STATUSES } },
        select: {
          id: true,
          customerName: true,
          partySize: true,
          status: true,
          secureToken: true,
        },
      },
    },
    orderBy: { startAt: 'asc' },
  });

  return sessions.map((session) => {
    const bookedGuests = session.bookings.reduce((s, b) => s + b.partySize, 0);
    return {
      type: 'activity_session',
      id: session.id,
      activityId: session.activityId,
      activityName: session.activity.name,
      category: session.activity.category,
      capacityMode: session.activity.capacityMode,
      startAt: session.startAt.toISOString(),
      endAt: session.endAt.toISOString(),
      capacity: session.capacity,
      bookedGuests,
      remainingCapacity: Math.max(0, session.capacity - bookedGuests),
      status: session.status,
      bookingsCount: session.bookings.length,
      bookings: session.bookings,
    };
  });
}

async function buildUnifiedCalendar(restaurantId, dateStr, range = 'day') {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, timezone: true, organization: { select: { owner: { select: { country: true } } } } },
  });
  if (!restaurant) return { events: [], date: dateStr, range };

  const timezone = getEffectiveTimezone(restaurant);
  const start = DateTime.fromISO(dateStr, { zone: timezone }).startOf('day');
  const end = range === 'week' ? start.plus({ days: 6 }).endOf('day') : start.endOf('day');

  const dates = [];
  let cur = start;
  while (cur <= end) {
    dates.push(cur.toFormat('yyyy-MM-dd'));
    cur = cur.plus({ days: 1 });
  }

  const events = [];

  for (const d of dates) {
    const serviceView = await buildServiceView(restaurantId, d);
    const activitySessions = await buildActivityDay(restaurantId, d);

    for (const res of serviceView.reservations ?? []) {
      events.push({
        type: 'reservation',
        id: res.id,
        date: d,
        startAt: res.dateTime,
        partySize: res.partySize,
        customerName: res.customerName,
        status: res.status,
        tableLabel: res.table?.label ?? null,
        source: res.source,
      });
    }

    for (const session of activitySessions) {
      events.push({ ...session, date: d });
    }
  }

  events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  return { events, date: dateStr, range, timezone };
}

module.exports = { buildUnifiedCalendar, buildActivityDay };
