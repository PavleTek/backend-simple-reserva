'use strict';

/** Estados que ocupan cupo en una sesión de actividad. */
const ACTIVE_ACTIVITY_BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'ARRIVED'];

const ALLOWED_ACTIVITY_BOOKING_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  ARRIVED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: ['CONFIRMED'],
  CANCELLED: ['CONFIRMED'],
  NO_SHOW: ['CONFIRMED'],
};

function canTransitionActivityBookingStatus(from, to) {
  if (!from || !to || from === to) return false;
  const allowed = ALLOWED_ACTIVITY_BOOKING_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  ACTIVE_ACTIVITY_BOOKING_STATUSES,
  ALLOWED_ACTIVITY_BOOKING_TRANSITIONS,
  canTransitionActivityBookingStatus,
};
