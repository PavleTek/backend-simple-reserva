'use strict';

function isWalkInReservation(r) {
  if (r && r.isWalkIn === true) return true;
  const n = (r?.notes || '').trim().toLowerCase();
  const name = (r?.customerName || '').trim();
  return n === 'walk-in' || name === 'Walk-in' || name === 'walk-in';
}

module.exports = { isWalkInReservation };
