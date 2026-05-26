'use strict';

/**
 * slotEngine/validate.js
 *
 * Validación de un slot para booking — usado en POST y PATCH /reservations (dentro de TX).
 *
 * A diferencia del sistema anterior (validateSlotInSchedule), este validador:
 * 1. Exige que la hora solicitada sea exactamente un cupo de la grilla generada.
 * 2. Valida ventana de reservas, duración, bloqueos, capacidad y holds.
 * 3. Usa el mismo motor que computeAvailability → coherencia perfecta.
 */

const { getReservationWindows, timeToMinutes } = require('./windows');
const { isOnGrid, timeToGridMinutes } = require('./grid');
const { getScheduleOpenMeta } = require('./businessDate');
const { resolveDuration } = require('./duration');
const { parseBlockedSlots, validateBookingPolicies } = require('./policies');
const { getCandidateTables, countFreeTables, checkPacing, parseReservations, parseHolds } = require('./capacity');

/**
 * Valida que un slot (hora + partySize) es válido para booking en un contexto dado.
 *
 * @param {object} params
 * @param {string} params.time - "HH:mm"
 * @param {number} params.partySize
 * @param {{ scheduleMode?: string; openTime?: string; closeTime?: string; [k: string]: any }|null} params.schedule
 * @param {{ slotIntervalMinutes?: number; defaultSlotDurationMinutes?: number;
 *            reservationEndPolicy?: string; reservationWindowMode?: string;
 *            bufferMinutesBetweenReservations?: number; minimumNoticeMinutes?: number;
 *            advanceBookingLimitDays?: number; holdsEnabled?: boolean }} params.restaurant
 * @param {Array<{ minPartySize: number; maxPartySize: number; durationMinutes: number }>} params.durationRules
 * @param {Array<{ startTime: string; endTime: string }>} params.customWindows
 * @param {Array<{ tableId: string|null; zoneId?: string; minCapacity: number; maxCapacity: number; sortOrder?: number; zone?: any }>} params.tables
 * @param {Array<{ tableId: string|null; startUtc: string; durationMinutes: number }>} params.reservations
 * @param {Array<{ tableId: string; startUtc: string; durationMinutes: number; holdToken: string }>} params.activeHolds
 * @param {Array<{ startUtc: string; endUtc: string }>} params.blockedSlots
 * @param {Array<{ dayOfWeek?: number|null; maxCoversPerSlot?: number|null; maxReservationsPerSlot?: number|null }>} params.pacingRules
 * @param {Date} params.slotDateTime - fecha+hora del slot en UTC
 * @param {Date} params.now
 * @param {boolean} [params.isToday]
 * @param {boolean} [params.walkIn]
 * @param {string|null} [params.zoneId]
 * @param {string|null} [params.excludeHoldToken] - hold propio del usuario
 * @param {number} [params.dayOfWeek]
 *
 * @returns {{ valid: boolean; durationMinutes?: number; reason?: string }}
 */
function validateSlotForBooking({
  time,
  partySize,
  schedule,
  restaurant,
  durationRules,
  customWindows = [],
  tables,
  reservations,
  activeHolds,
  blockedSlots,
  pacingRules = [],
  slotDateTime,
  now,
  isToday = false,
  walkIn = false,
  zoneId = null,
  excludeHoldToken = null,
  dayOfWeek,
}) {
  if (!schedule) {
    return { valid: false, reason: 'no_schedule' };
  }

  const scheduleMode = schedule.scheduleMode ?? restaurant.scheduleMode ?? 'continuous';
  const reservationWindowMode = restaurant.reservationWindowMode ?? 'same_as_schedule';
  const reservationEndPolicy = restaurant.reservationEndPolicy ?? 'STRICT_END';
  const intervalMinutes = restaurant.slotIntervalMinutes ?? restaurant.defaultSlotDurationMinutes ?? 60;
  const bufferMs = (restaurant.bufferMinutesBetweenReservations ?? 0) * 60000;
  const minimumNoticeMinutes = restaurant.minimumNoticeMinutes ?? 60;
  const advanceBookingLimitDays = restaurant.advanceBookingLimitDays ?? 30;

  const durationMinutes = resolveDuration(restaurant, partySize, durationRules);

  // 1. El tiempo solicitado debe estar en la grilla generada (cross-midnight: 01:00 → minuto 1500, no 60)
  const { openMin, closesNextDay } = getScheduleOpenMeta(schedule, scheduleMode);
  const timeMinWall = timeToMinutes(time);
  const nextDayLeg = closesNextDay && timeMinWall < openMin;
  const timeMin = timeToGridMinutes(time, nextDayLeg);

  const windows = getReservationWindows(schedule, scheduleMode, reservationWindowMode, customWindows);
  if (!isOnGrid(timeMin, windows, intervalMinutes, durationMinutes, reservationEndPolicy)) {
    return { valid: false, reason: 'slot_not_on_grid' };
  }

  // 2. Políticas de aviso y anticipación
  const policyCheck = validateBookingPolicies(slotDateTime, now, minimumNoticeMinutes, advanceBookingLimitDays, walkIn);
  if (!policyCheck.valid) {
    return { valid: false, reason: policyCheck.reason };
  }

  // 3. Bloqueos
  const parsedBlocked = parseBlockedSlots(blockedSlots);
  const slotEnd = new Date(slotDateTime.getTime() + durationMinutes * 60000);
  const isBlocked = parsedBlocked.some((bs) => slotDateTime < bs.end && slotEnd > bs.start);
  if (isBlocked) {
    return { valid: false, reason: 'blocked' };
  }

  // 4. Mesas disponibles (una reserva = una mesa)
  const candidateTables = getCandidateTables(tables, partySize, zoneId);
  if (candidateTables.length === 0) {
    const anyTable = getCandidateTables(tables, partySize, null);
    return {
      valid: false,
      reason: anyTable.length === 0 ? 'party_size_exceeds_largest_table' : 'no_tables_in_zone',
    };
  }

  const parsedRes = parseReservations(reservations);
  const parsedHolds = parseHolds(activeHolds);
  const freeTables = countFreeTables(candidateTables, slotDateTime, slotEnd, bufferMs, parsedRes, parsedHolds, excludeHoldToken);
  if (freeTables === 0) {
    return { valid: false, reason: 'no_tables_available' };
  }

  // 5. Pacing
  if (pacingRules.length > 0) {
    // Calcular personas y reservas confirmadas (reservas + holds activos) en este slot
    const slotReservations = parsedRes.filter((r) => slotDateTime < r.end && slotEnd > r.start);
    const slotHolds = parsedHolds.filter((h) => {
      if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
      return slotDateTime < h.end && slotEnd > h.start;
    });
    const confirmedCovers = slotReservations.reduce((acc, _r) => acc, 0) + slotHolds.reduce((acc, _h) => acc, 0);
    const confirmedReservations = slotReservations.length + slotHolds.length;
    const dow = dayOfWeek ?? slotDateTime.getDay();
    const pacingCheck = checkPacing(pacingRules, dow, confirmedCovers, confirmedReservations, partySize);
    if (!pacingCheck.ok) {
      return { valid: false, reason: pacingCheck.reason };
    }
  }

  return { valid: true, durationMinutes };
}

module.exports = { validateSlotForBooking };
