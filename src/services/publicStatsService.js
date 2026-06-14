const { DateTime } = require('luxon');
const prisma = require('../lib/prisma');

const MIN_CONFIRMED_FOR_MOBILE = 5;
const MIN_PAGE_VIEWS_FOR_MOBILE = 30;

function luxonDowToSchema(luxonWeekday) {
  return luxonWeekday === 7 ? 0 : luxonWeekday;
}

function parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

function isCreatedAtInBusinessHours(createdAt, timezone, schedules) {
  const tz = timezone || 'America/Santiago';
  const local = DateTime.fromJSDate(createdAt, { zone: 'utc' }).setZone(tz);
  if (!local.isValid) return true;

  const dayOfWeek = luxonDowToSchema(local.weekday);
  const minutes = local.hour * 60 + local.minute;
  const daySchedules = schedules.filter((s) => s.dayOfWeek === dayOfWeek);

  if (daySchedules.length === 0) {
    return minutes >= 8 * 60 && minutes <= 23 * 60;
  }

  return daySchedules.some((s) => {
    const open = parseTimeToMinutes(s.openTime);
    let close = parseTimeToMinutes(s.closeTime);
    if (s.closesNextDay) close += 24 * 60;
    return minutes >= open && minutes <= close;
  });
}

async function computePctOutsideBusinessHours(notCancelled) {
  const reservations = await prisma.reservation.findMany({
    where: notCancelled,
    select: {
      createdAt: true,
      restaurant: {
        select: {
          timezone: true,
          schedules: {
            where: { isActive: true },
            select: {
              dayOfWeek: true,
              openTime: true,
              closeTime: true,
              closesNextDay: true,
            },
          },
        },
      },
    },
  });

  if (reservations.length === 0) return null;

  let outside = 0;
  for (const r of reservations) {
    const schedules = r.restaurant?.schedules ?? [];
    const tz = r.restaurant?.timezone;
    if (!isCreatedAtInBusinessHours(r.createdAt, tz, schedules)) outside += 1;
  }

  return (outside / reservations.length) * 100;
}

function isPhoneBookingEvent(deviceType, properties) {
  if (deviceType === 'mobile' || deviceType === 'tablet') return true;
  const width = properties?.viewport?.width;
  return typeof width === 'number' && width < 1024;
}

async function pctPhoneBookingsForEvent(eventName) {
  const events = await prisma.bookingEvent.findMany({
    where: { eventName },
    select: { deviceType: true, properties: true },
  });
  if (events.length === 0) return { pct: null, total: 0 };

  let phone = 0;
  for (const event of events) {
    if (isPhoneBookingEvent(event.deviceType, event.properties)) phone += 1;
  }
  return { pct: (phone / events.length) * 100, total: events.length };
}

async function computePctMobileBookings() {
  const [pageViews, confirmed] = await Promise.all([
    pctPhoneBookingsForEvent('booking.page_view'),
    pctPhoneBookingsForEvent('booking.confirmed'),
  ]);

  // page_view refleja mejor el dispositivo real (confirmed suele perderse al redirigir).
  if (pageViews.total >= MIN_PAGE_VIEWS_FOR_MOBILE && pageViews.pct != null) {
    return pageViews.pct;
  }
  if (confirmed.total >= MIN_CONFIRMED_FOR_MOBILE && confirmed.pct != null) {
    return confirmed.pct;
  }
  return null;
}

async function getPublicStats() {
  const notCancelled = { status: { not: 'cancelled' } };

  const [
    totalReservations,
    coversAgg,
    totalLocalesRegistered,
    localesWithReservationsGroups,
    webReservations,
    pctMobileBookings,
    pctOutsideBusinessHours,
  ] = await Promise.all([
    prisma.reservation.count({ where: notCancelled }),
    prisma.reservation.aggregate({ where: notCancelled, _sum: { partySize: true } }),
    prisma.restaurant.count({ where: { isDeleted: false } }),
    prisma.reservation.groupBy({
      by: ['restaurantId'],
      where: notCancelled,
    }),
    prisma.reservation.count({ where: { ...notCancelled, source: 'web' } }),
    computePctMobileBookings(),
    computePctOutsideBusinessHours(notCancelled),
  ]);

  const totalCovers = coversAgg._sum.partySize ?? 0;
  const localesWithReservations = localesWithReservationsGroups.length;

  const pctOnlineReservations =
    totalReservations > 0 ? (webReservations / totalReservations) * 100 : null;

  return {
    totalReservations,
    totalCovers,
    totalLocalesRegistered,
    localesWithReservations,
    pctOnlineReservations,
    pctMobileBookings,
    pctOutsideBusinessHours,
    medianDaysToFirstReservation: null,
  };
}

module.exports = { getPublicStats };
