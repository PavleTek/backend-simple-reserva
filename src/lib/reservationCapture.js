'use strict';

const { normalizePhone } = require('./phone');

function lifecycleFieldsForStatus(to, now = new Date()) {
  if (to === 'arrived') return { arrivedAt: now };
  if (to === 'completed') return { completedAt: now };
  if (to === 'cancelled') return { cancelledAt: now };
  return {};
}

function resolveWalkInContact({ name, phone, defaultCountry = 'CL' } = {}) {
  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : 'Walk-in';
  return {
    customerName: trimmedName,
    customerPhone: normalizePhone(phone, { defaultCountry }),
    isWalkIn: true,
  };
}

async function markFirstReservationReceived(db, restaurantId, reservationId, at = new Date()) {
  if (!restaurantId || !reservationId) return;
  await db.restaurant.updateMany({
    where: { id: restaurantId, firstReservationReceivedAt: null },
    data: {
      firstReservationReceivedAt: at,
      firstReservationId: reservationId,
    },
  });
}

module.exports = {
  lifecycleFieldsForStatus,
  resolveWalkInContact,
  markFirstReservationReceived,
};
