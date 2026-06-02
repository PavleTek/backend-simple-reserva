'use strict';

const LATE_GRACE_MINUTES = 10;
const RESERVATION_SOON_MINUTES = 60;

function reservationIsWalkIn(r) {
  const n = (r.notes || '').trim().toLowerCase();
  const name = (r.customerName || '').trim();
  return n === 'walk-in' || name === 'Walk-in' || name === 'walk-in';
}

function reservationPayload(r, rEnd) {
  const base = {
    id: r.id,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    partySize: r.partySize,
    dateTime: r.dateTime,
  };
  if (rEnd) base.dateTimeEnd = rEnd;
  if (r.status) base.status = r.status;
  return base;
}

function reservationEnd(r, bufferMs) {
  const rStart = new Date(r.dateTime);
  const durationMs = (r.durationMinutes ?? 90) * 60000;
  return new Date(rStart.getTime() + durationMs + bufferMs);
}

/**
 * Estado operacional de una mesa para plano y listado.
 * Evalúa todas las reservas de la mesa (sin cortar al primer «arrived») para no perder la siguiente.
 */
function computeTableFloorStatus(tableReservations, now, bufferMs = 0) {
  let currentReservation = null;
  let nextReservation = null;
  let lateReservation = null;
  let isOccupied = false;
  let isLate = false;

  const sorted = [...tableReservations].sort(
    (a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime(),
  );

  for (const r of sorted) {
    const rStart = new Date(r.dateTime);
    const rEnd = reservationEnd(r, bufferMs);

    if (rStart > now) {
      if (!nextReservation) {
        nextReservation = reservationPayload(r);
      }
      continue;
    }

    if (r.status === 'arrived') {
      if (now < rEnd || reservationIsWalkIn(r)) {
        isOccupied = true;
        currentReservation = reservationPayload(r, rEnd);
      }
      continue;
    }

    if (r.status === 'confirmed' && now >= rStart && now < rEnd) {
      const minutesLate = (now.getTime() - rStart.getTime()) / 60000;
      if (minutesLate >= LATE_GRACE_MINUTES) {
        isLate = true;
        if (!lateReservation) lateReservation = reservationPayload(r);
      } else {
        isOccupied = true;
        currentReservation = reservationPayload(r, rEnd);
      }
      continue;
    }

    if (now > rEnd) {
      if (reservationIsWalkIn(r)) {
        isOccupied = true;
        currentReservation = reservationPayload(r, rEnd);
        continue;
      }
      if (r.status === 'confirmed' && !lateReservation) {
        isLate = true;
        lateReservation = reservationPayload(r);
      }
    }
  }

  let status = 'free';
  let minutesUntilNext = Infinity;
  if (nextReservation) {
    minutesUntilNext =
      (new Date(nextReservation.dateTime).getTime() - now.getTime()) / 60000;
  }

  if (isLate) {
    status = 'late_arrival';
    currentReservation = lateReservation ?? currentReservation;
  } else if (
    nextReservation &&
    minutesUntilNext >= 0 &&
    minutesUntilNext <= RESERVATION_SOON_MINUTES
  ) {
    status = 'reserved_soon';
  } else if (isOccupied) {
    status = 'occupied';
  } else if (nextReservation) {
    status = 'upcoming';
  }

  return { status, currentReservation, nextReservation };
}

module.exports = {
  LATE_GRACE_MINUTES,
  RESERVATION_SOON_MINUTES,
  computeTableFloorStatus,
  reservationIsWalkIn,
};
