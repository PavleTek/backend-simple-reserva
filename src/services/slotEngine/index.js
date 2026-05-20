'use strict';

/**
 * slotEngine/index.js  — Motor de disponibilidad v3
 *
 * API pública del motor. Única fuente de verdad para generación de cupos,
 * cálculo de disponibilidad y validación de reservas.
 *
 * Versión: 3
 * Contratos:
 *  - computeAvailability(snapshot, opts) → { slots, reason?, meta }
 *  - validateSlotForBooking(params)      → { valid, durationMinutes?, reason? }
 *  - previewSlots(config)                → string[]   (para endpoint de preview de config)
 *  - getDaySnapshot(restaurant, opts)    → Promise<DaySnapshot>
 */

const prisma = require('../../lib/prisma');
const {
  getEffectiveTimezone,
  parseInTimezone,
  nowInTimezone,
  getDayOfWeekInTimezone,
} = require('../../utils/timezone');
const { hasActiveAccess } = require('../subscriptionService');
const { DateTime } = require('luxon');

const { getReservationWindows, minutesToTime } = require('./windows');
const { generateGrid } = require('./grid');
const { resolveDuration } = require('./duration');
const { parseBlockedSlots, applyPolicies } = require('./policies');
const {
  getCandidateTables,
  countFreeTables,
  checkPacing,
  parseReservations,
  parseHolds,
} = require('./capacity');
const { validateSlotForBooking } = require('./validate');

const ENGINE_VERSION = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Lookback unificado: reservas y holds del día anterior que pueden solapar mañana.
 * Usa la mayor duración posible (máximo de durationRules o default) para no perder
 * reservas que cruzaron la medianoche.
 * @param {number} defaultSlotDurationMinutes
 * @param {Array<{ durationMinutes: number }>} durationRules
 * @returns {number} milisegundos de lookback
 */
function lookbackMs(defaultSlotDurationMinutes, durationRules) {
  const maxDuration = durationRules.reduce(
    (max, r) => Math.max(max, r.durationMinutes),
    defaultSlotDurationMinutes ?? 60
  );
  return Math.max(maxDuration, 12 * 60) * 60000; // mínimo 12h para cenas largas
}

// ─── loadDaySnapshot ────────────────────────────────────────────────────────

/**
 * Carga todos los datos necesarios para computar disponibilidad en un día.
 * Snapshot inmutable, sin PII de cliente.
 *
 * @param {{ id: string; defaultSlotDurationMinutes: number; slotIntervalMinutes: number;
 *            reservationEndPolicy: string; reservationWindowMode: string; scheduleMode: string;
 *            bufferMinutesBetweenReservations: number; minimumNoticeMinutes: number;
 *            advanceBookingLimitDays: number; holdTtlSeconds: number; holdsEnabled: boolean;
 *            timezone?: string }} restaurant
 * @param {{ dateStr: string; timezone: string }} opts
 */
async function loadDaySnapshot(restaurant, { dateStr, timezone }) {
  const dayStart = parseInTimezone(dateStr, '00:00', timezone);
  const dayEnd = parseInTimezone(dateStr, '23:59', timezone);

  const dayOfWeek = getDayOfWeekInTimezone(dateStr, timezone);

  // Lookback dinámico para capturar reservas del día anterior que aún bloquean mesas
  const durationRulesRaw = await prisma.durationRule.findMany({
    where: { restaurantId: restaurant.id },
  });
  const lb = lookbackMs(restaurant.defaultSlotDurationMinutes, durationRulesRaw);
  const windowStart = new Date(dayStart.getTime() - lb);

  const now = new Date();

  const [
    schedule,
    allTables,
    allZones,
    blockedSlots,
    reservations,
    reservationWindows,
    activeHolds,
    pacingRules,
  ] = await Promise.all([
    prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    }),
    prisma.restaurantTable.findMany({
      where: {
        isActive: true,
        zone: { restaurantId: restaurant.id, isActive: true },
      },
      include: { zone: { select: { id: true, sortOrder: true } } },
      orderBy: { maxCapacity: 'asc' },
    }),
    prisma.zone.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, sortOrder: true, smokingZone: true },
    }),
    prisma.blockedSlot.findMany({
      where: {
        restaurantId: restaurant.id,
        startDatetime: { lte: dayEnd },
        endDatetime: { gte: dayStart },
      },
    }),
    prisma.reservation.findMany({
      where: {
        restaurantId: restaurant.id,
        status: 'confirmed',
        dateTime: { gte: windowStart, lte: dayEnd },
      },
      select: { tableId: true, dateTime: true, durationMinutes: true },
    }),
    prisma.reservationWindow.findMany({
      where: { restaurantId: restaurant.id, dayOfWeek },
      orderBy: { sortOrder: 'asc' },
    }),
    // Holds activos (no expirados) para el mismo rango
    restaurant.holdsEnabled
      ? prisma.reservationHold.findMany({
          where: {
            restaurantId: restaurant.id,
            status: 'active',
            expiresAt: { gt: now },
            dateTime: { gte: windowStart, lte: dayEnd },
          },
          select: { tableId: true, dateTime: true, durationMinutes: true, holdToken: true },
        })
      : Promise.resolve([]),
    prisma.pacingRule.findMany({
      where: { restaurantId: restaurant.id },
    }),
  ]);

  const serverNow = nowInTimezone(timezone).toJSDate();
  const todayLocal = nowInTimezone(timezone).toFormat('yyyy-MM-dd');

  return {
    restaurantId: restaurant.id,
    date: dateStr,
    timezone,
    schedule: schedule
      ? {
          dayOfWeek: schedule.dayOfWeek,
          scheduleMode: restaurant.scheduleMode,
          openTime: schedule.openTime,
          closeTime: schedule.closeTime,
          breakfastStartTime: schedule.breakfastStartTime ?? null,
          breakfastEndTime: schedule.breakfastEndTime ?? null,
          lunchStartTime: schedule.lunchStartTime ?? null,
          lunchEndTime: schedule.lunchEndTime ?? null,
          dinnerStartTime: schedule.dinnerStartTime ?? null,
          dinnerEndTime: schedule.dinnerEndTime ?? null,
        }
      : null,
    defaults: {
      engineVersion: ENGINE_VERSION,
      slotDurationMinutes: restaurant.defaultSlotDurationMinutes,
      slotIntervalMinutes: restaurant.slotIntervalMinutes ?? restaurant.defaultSlotDurationMinutes,
      reservationEndPolicy: restaurant.reservationEndPolicy ?? 'STRICT_END',
      reservationWindowMode: restaurant.reservationWindowMode ?? 'same_as_schedule',
      bufferMinutesBetweenReservations: restaurant.bufferMinutesBetweenReservations ?? 0,
      minimumNoticeMinutes: restaurant.minimumNoticeMinutes ?? 60,
      advanceBookingLimitDays: restaurant.advanceBookingLimitDays ?? 30,
      holdsEnabled: restaurant.holdsEnabled ?? true,
    },
    reservationWindows: reservationWindows.map((w) => ({
      dayOfWeek: w.dayOfWeek,
      startTime: w.startTime,
      endTime: w.endTime,
      label: w.label,
      sortOrder: w.sortOrder,
    })),
    durationRules: durationRulesRaw.map((r) => ({
      minPartySize: r.minPartySize,
      maxPartySize: r.maxPartySize,
      durationMinutes: r.durationMinutes,
    })),
    tables: allTables.map((t) => ({
      id: t.id,
      zoneId: t.zone.id,
      minCapacity: t.minCapacity,
      maxCapacity: t.maxCapacity,
      sortOrder: t.sortOrder ?? 0,
      zoneSortOrder: t.zone.sortOrder ?? 0,
      zone: { id: t.zone.id, sortOrder: t.zone.sortOrder ?? 0 },
    })),
    zones: allZones,
    blockedSlots: blockedSlots.map((bs) => ({
      startUtc: bs.startDatetime.toISOString(),
      endUtc: bs.endDatetime.toISOString(),
    })),
    reservations: reservations.map((r) => ({
      tableId: r.tableId,
      startUtc: r.dateTime.toISOString(),
      durationMinutes: r.durationMinutes,
    })),
    activeHolds: activeHolds.map((h) => ({
      tableId: h.tableId,
      startUtc: h.dateTime.toISOString(),
      durationMinutes: h.durationMinutes,
      holdToken: h.holdToken,
    })),
    pacingRules: pacingRules.map((p) => ({
      dayOfWeek: p.dayOfWeek,
      maxCoversPerSlot: p.maxCoversPerSlot,
      maxReservationsPerSlot: p.maxReservationsPerSlot,
    })),
    serverNowUtc: serverNow.toISOString(),
    isToday: dateStr === todayLocal,
  };
}

// ─── computeAvailability ─────────────────────────────────────────────────────

/**
 * Computa disponibilidad pura desde un snapshot (sin tocar la DB).
 * Toda la lógica es determinista dado el mismo snapshot.
 *
 * @param {ReturnType<typeof loadDaySnapshot>} snapshot
 * @param {{ partySize: number; zoneId?: string|null; now?: Date; walkIn?: boolean; excludeHoldToken?: string|null }} opts
 * @returns {{ slots: Array<{ time: string; available: boolean; availableTables: number; coversRemaining?: number }>; reason?: string; meta?: object }}
 */
function computeAvailability(snapshot, { partySize, zoneId, now, walkIn = false, excludeHoldToken = null }) {
  const {
    schedule,
    defaults,
    durationRules,
    tables,
    blockedSlots,
    reservations,
    activeHolds,
    pacingRules,
    reservationWindows,
    isToday,
    timezone,
    date,
  } = snapshot;

  if (!schedule) return { slots: [], reason: 'no_schedule' };

  // Una mesa individual debe calzar; sin combinaciones
  const candidateTables = getCandidateTables(tables, partySize, zoneId ?? null);
  if (candidateTables.length === 0) {
    const anyTable = getCandidateTables(tables, partySize, null);
    return {
      slots: [],
      reason: anyTable.length === 0 ? 'party_size_exceeds_largest_table' : 'no_tables_in_zone',
    };
  }

  const scheduleMode = schedule.scheduleMode ?? 'continuous';
  const durationMinutes = resolveDuration(
    { defaultSlotDurationMinutes: defaults.slotDurationMinutes },
    partySize,
    durationRules
  );
  const intervalMinutes = defaults.slotIntervalMinutes;
  const reservationEndPolicy = defaults.reservationEndPolicy;
  const reservationWindowMode = defaults.reservationWindowMode;

  const windows = getReservationWindows(
    schedule,
    scheduleMode,
    reservationWindowMode,
    reservationWindows ?? []
  );

  const slotDefs = generateGrid(windows, intervalMinutes, durationMinutes, reservationEndPolicy);
  if (slotDefs.length === 0) return { slots: [], reason: 'no_slots' };

  const timeSlots = slotDefs.map(({ time }) => {
    const start = parseInTimezone(date, time, timezone);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return { time, start, end };
  });

  const nowDate = now instanceof Date ? now : new Date(snapshot.serverNowUtc);
  const parsedBlocked = parseBlockedSlots(blockedSlots);
  const filteredSlots = applyPolicies(timeSlots, {
    isToday,
    walkIn,
    nowDate,
    minimumNoticeMinutes: defaults.minimumNoticeMinutes,
    parsedBlockedSlots: parsedBlocked,
  });

  const bufferMs = defaults.bufferMinutesBetweenReservations * 60000;
  const parsedRes = parseReservations(reservations);
  const parsedHoldsArr = parseHolds(activeHolds);

  const available = [];
  for (const slot of filteredSlots) {
    const openTables = countFreeTables(
      candidateTables,
      slot.start,
      slot.end,
      bufferMs,
      parsedRes,
      parsedHoldsArr,
      excludeHoldToken
    );
    if (openTables === 0) continue;

    // Pacing check
    let coversRemaining;
    if (pacingRules.length > 0) {
      const slotRes = parsedRes.filter((r) => slot.start < r.end && slot.end > r.start);
      const slotHolds = parsedHoldsArr.filter((h) => {
        if (excludeHoldToken && h.holdToken === excludeHoldToken) return false;
        return slot.start < h.end && slot.end > h.start;
      });
      const confirmedCovers = slotRes.length + slotHolds.length; // rough count for pacing UI
      const confirmedCount = slotRes.length + slotHolds.length;
      const dow = getDayOfWeekInTimezone(date, timezone);
      const pacingCheck = checkPacing(pacingRules, dow, confirmedCovers, confirmedCount, partySize);
      if (!pacingCheck.ok) continue;
      if (pacingCheck.coversRemaining != null) coversRemaining = pacingCheck.coversRemaining;
    }

    const entry = { time: slot.time, available: true, availableTables: openTables };
    if (coversRemaining != null) entry.coversRemaining = coversRemaining;
    available.push(entry);
  }

  if (available.length === 0) return { slots: [], reason: 'no_availability' };

  return {
    slots: available,
    meta: {
      engineVersion: ENGINE_VERSION,
      slotIntervalMinutes: intervalMinutes,
      reservationDurationMinutes: durationMinutes,
    },
  };
}

// ─── previewSlots ─────────────────────────────────────────────────────────────

/**
 * Genera slots de vista previa a partir de config tentativa (sin acceder a DB de capacidad).
 * Solo la grilla lógica — sin mesas, bloqueos ni holds.
 * Usado por POST /availability/preview.
 *
 * @param {{ schedule: object; scheduleMode?: string;
 *            reservationWindowMode?: string; customWindows?: Array<any>;
 *            slotIntervalMinutes: number; defaultSlotDurationMinutes: number;
 *            reservationEndPolicy?: string; partySize?: number;
 *            durationRules?: Array<any> }} config
 * @returns {string[]} - array de "HH:mm"
 */
function previewSlots(config) {
  const {
    schedule,
    scheduleMode = 'continuous',
    reservationWindowMode = 'same_as_schedule',
    customWindows = [],
    slotIntervalMinutes,
    defaultSlotDurationMinutes,
    reservationEndPolicy = 'STRICT_END',
    partySize = 2,
    durationRules = [],
  } = config;

  if (!schedule) return [];

  const durationMinutes = resolveDuration(
    { defaultSlotDurationMinutes },
    partySize,
    durationRules
  );

  const windows = getReservationWindows(
    schedule,
    scheduleMode,
    reservationWindowMode,
    customWindows
  );

  return generateGrid(windows, slotIntervalMinutes, durationMinutes, reservationEndPolicy).map(
    (s) => s.time
  );
}

// ─── Availability helpers (with DB) ─────────────────────────────────────────

/**
 * Carga snapshot y computa disponibilidad en un solo paso.
 */
async function getAvailabilitySlotsForRestaurant(
  restaurant,
  { dateStr, partySize, zoneId, timezone, walkIn }
) {
  const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
  return computeAvailability(snapshot, {
    partySize,
    zoneId: zoneId || null,
    now: new Date(snapshot.serverNowUtc),
    walkIn: !!walkIn,
  });
}

/**
 * Busca el próximo día futuro con disponibilidad para un slug de restaurante.
 */
async function findNextAvailableDateForSlug(slug, { fromDateStr, partySize, zoneId }) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug, isActive: true, isDeleted: false },
    include: {
      organization: { include: { owner: { select: { country: true } } } },
    },
  });
  if (!restaurant) return { ok: false, error: 'not_found' };

  const access = await hasActiveAccess(restaurant.organizationId);
  if (!access) return { ok: true, nextDate: null, reason: 'subscription_expired' };

  const ownerCountry = restaurant.organization?.owner?.country || 'CL';
  const timezone = getEffectiveTimezone(restaurant, ownerCountry);
  const advanceDays = restaurant.advanceBookingLimitDays ?? 30;

  let cursor = DateTime.fromISO(fromDateStr, { zone: timezone }).plus({ days: 1 });
  const limitEnd = DateTime.now().setZone(timezone).plus({ days: advanceDays });

  while (cursor.startOf('day') <= limitEnd.endOf('day')) {
    const dateStr = cursor.toFormat('yyyy-MM-dd');
    const snapshot = await loadDaySnapshot(restaurant, { dateStr, timezone });
    const result = computeAvailability(snapshot, {
      partySize,
      zoneId: zoneId || null,
      now: new Date(snapshot.serverNowUtc),
    });
    if (result.slots.length > 0) {
      return { ok: true, nextDate: dateStr, slotsCount: result.slots.length };
    }
    cursor = cursor.plus({ days: 1 });
  }

  return { ok: true, nextDate: null, reason: 'no_future_availability' };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ENGINE_VERSION,
  loadDaySnapshot,
  computeAvailability,
  validateSlotForBooking,
  previewSlots,
  getAvailabilitySlotsForRestaurant,
  findNextAvailableDateForSlug,
  // Re-export helpers para uso en routes/controllers
  resolveDuration,
};
