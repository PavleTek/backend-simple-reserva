'use strict';

/**
 * Tests unitarios del motor de disponibilidad v3.
 * Corre con: node --test src/services/slotEngine/__tests__/slotEngine.test.js
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { getOperatingWindows, getReservationWindows, minutesToTime, timeToMinutes } = require('../windows');
const { generateGrid, alignToGrid, isOnGrid } = require('../grid');
const { resolveDuration } = require('../duration');
const {
  getCandidateTables,
  countFreeTables,
  checkPacing,
  parseReservations,
  parseHolds,
  pickTable,
} = require('../capacity');
const { applyPolicies, validateBookingPolicies, parseBlockedSlots } = require('../policies');
const { validateSlotForBooking } = require('../validate');
const { previewSlots } = require('../index');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SCHEDULE_CONTINUOUS = {
  scheduleMode: 'continuous',
  openTime: '12:00',
  closeTime: '22:00',
};

const SCHEDULE_SERVICE_PERIODS = {
  scheduleMode: 'service_periods',
  lunchStartTime: '12:00',
  lunchEndTime: '15:00',
  dinnerStartTime: '19:00',
  dinnerEndTime: '22:00',
};

const TABLE_4 = { id: 't1', zoneId: 'z1', minCapacity: 1, maxCapacity: 4, sortOrder: 0, zone: { id: 'z1', sortOrder: 0 } };
const TABLE_6 = { id: 't2', zoneId: 'z1', minCapacity: 5, maxCapacity: 6, sortOrder: 1, zone: { id: 'z1', sortOrder: 0 } };
const TABLE_8 = { id: 't3', zoneId: 'z2', minCapacity: 1, maxCapacity: 8, sortOrder: 0, zone: { id: 'z2', sortOrder: 1 } };
const ALL_TABLES = [TABLE_4, TABLE_6, TABLE_8];

function makeSlotDate(dateStr, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

// ─── windows.js ─────────────────────────────────────────────────────────────

describe('windows', () => {
  it('timeToMinutes / minutesToTime son inversos', () => {
    assert.equal(timeToMinutes('09:00'), 540);
    assert.equal(timeToMinutes('22:30'), 1350);
    assert.equal(minutesToTime(540), '09:00');
    assert.equal(minutesToTime(1350), '22:30');
  });

  it('getOperatingWindows continuous retorna rango correcto', () => {
    const windows = getOperatingWindows(SCHEDULE_CONTINUOUS, 'continuous');
    assert.deepEqual(windows, [[720, 1320]]); // 12:00 → 22:00
  });

  it('getOperatingWindows cross-midnight bar 18:00 → 03:00', () => {
    process.env.FF_CROSS_MIDNIGHT = 'true';
    const windows = getOperatingWindows(
      { openTime: '18:00', closeTime: '03:00', closesNextDay: true },
      'continuous',
    );
    assert.deepEqual(windows, [[1080, 1620]]); // 18:00 → 27:00 (03:00 next day)
    delete process.env.FF_CROSS_MIDNIGHT;
  });

  it('generateGrid incluye slots post-medianoche', () => {
    process.env.FF_CROSS_MIDNIGHT = 'true';
    const slots = generateGrid([[1080, 1620]], 30, 60, 'STRICT_END');
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('23:30'));
    assert.ok(times.includes('00:30'));
    assert.ok(times.includes('00:00') || times.includes('00:30'));
    delete process.env.FF_CROSS_MIDNIGHT;
  });

  it('getOperatingWindows service_periods omite periodos vacíos', () => {
    const windows = getOperatingWindows(SCHEDULE_SERVICE_PERIODS, 'service_periods');
    assert.deepEqual(windows, [[720, 900], [1140, 1320]]);
  });

  it('getReservationWindows custom usa ventanas personalizadas', () => {
    const custom = [{ startTime: '19:00', endTime: '21:00' }];
    const windows = getReservationWindows(SCHEDULE_CONTINUOUS, 'continuous', 'custom', custom);
    assert.deepEqual(windows, [[1140, 1260]]);
  });

  it('getReservationWindows same_as_schedule ignora custom vacío', () => {
    const windows = getReservationWindows(SCHEDULE_CONTINUOUS, 'continuous', 'same_as_schedule', []);
    assert.deepEqual(windows, [[720, 1320]]);
  });

  it('schedule null retorna array vacío', () => {
    assert.deepEqual(getOperatingWindows(null), []);
  });
});

// ─── grid.js ─────────────────────────────────────────────────────────────────

describe('grid', () => {
  it('alinea correctamente al grid', () => {
    assert.equal(alignToGrid(730, 60), 780); // 12:10 → alinea a 13:00
    assert.equal(alignToGrid(720, 60), 720); // 12:00 ya está alineado
    assert.equal(alignToGrid(722, 15), 735); // 12:02 → 12:15
  });

  it('genera grid de 60min entre 12:00 y 22:00', () => {
    const slots = generateGrid([[720, 1320]], 60, 60);
    const times = slots.map((s) => s.time);
    assert.deepEqual(times, ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
  });

  it('genera grid de 15min entre 19:00 y 21:00', () => {
    const slots = generateGrid([[1140, 1260]], 15, 60, 'STRICT_END');
    const times = slots.map((s) => s.time);
    assert.deepEqual(times, ['19:00', '19:15', '19:30', '19:45', '20:00']);
  });

  it('ALLOW_OVERFLOW permite cupo final aunque reserva supere cierre', () => {
    const slots = generateGrid([[720, 780]], 30, 60, 'ALLOW_OVERFLOW');
    const times = slots.map((s) => s.time);
    assert.ok(times.includes('12:30')); // 12:30 + 60min = 13:30 supera 13:00 pero ALLOW_OVERFLOW
  });

  it('STRICT_END no permite cupo si reserva supera cierre', () => {
    const slots = generateGrid([[720, 780]], 30, 60, 'STRICT_END');
    const times = slots.map((s) => s.time);
    assert.ok(!times.includes('12:30')); // 12:30 + 60min = 13:30 > 13:00
    assert.ok(times.includes('12:00')); // 12:00 + 60min = 13:00 ok
  });

  it('isOnGrid detecta cupo válido', () => {
    assert.equal(isOnGrid(720, [[720, 1320]], 60, 60), true);  // 12:00
    assert.equal(isOnGrid(780, [[720, 1320]], 60, 60), true);  // 13:00
    assert.equal(isOnGrid(730, [[720, 1320]], 60, 60), false); // 12:10 no está en grilla
    assert.equal(isOnGrid(735, [[720, 1320]], 15, 60), true);  // 12:15 ok con intervalo 15
  });

  it('isOnGrid rechaza cupo que supera ventana (STRICT_END)', () => {
    // 21:30 + 60min = 22:30 > 22:00
    assert.equal(isOnGrid(1290, [[720, 1320]], 60, 60, 'STRICT_END'), false);
    // 21:00 + 60min = 22:00 ok
    assert.equal(isOnGrid(1260, [[720, 1320]], 60, 60, 'STRICT_END'), true);
  });
});

// ─── duration.js ─────────────────────────────────────────────────────────────

describe('duration', () => {
  it('usa regla correcta para party size', () => {
    const rules = [
      { minPartySize: 1, maxPartySize: 2, durationMinutes: 60 },
      { minPartySize: 3, maxPartySize: 4, durationMinutes: 90 },
      { minPartySize: 5, maxPartySize: 8, durationMinutes: 120 },
    ];
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 60 }, 1, rules), 60);
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 60 }, 2, rules), 60);
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 60 }, 3, rules), 90);
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 60 }, 6, rules), 120);
  });

  it('usa default cuando party size no cubre ninguna regla', () => {
    const rules = [{ minPartySize: 1, maxPartySize: 4, durationMinutes: 90 }];
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 60 }, 10, rules), 60);
  });

  it('usa default cuando no hay reglas', () => {
    assert.equal(resolveDuration({ defaultSlotDurationMinutes: 75 }, 3, []), 75);
  });
});

// ─── capacity.js ─────────────────────────────────────────────────────────────

describe('capacity', () => {
  it('getCandidateTables filtra por partySize', () => {
    const candidates = getCandidateTables(ALL_TABLES, 5, null);
    assert.ok(candidates.some((t) => t.id === 't2')); // mesa 5-6
    assert.ok(candidates.some((t) => t.id === 't3')); // mesa 1-8
    assert.ok(!candidates.some((t) => t.id === 't1')); // mesa 1-4 no admite 5
  });

  it('getCandidateTables filtra por zona', () => {
    const candidates = getCandidateTables(ALL_TABLES, 2, 'z1');
    assert.ok(!candidates.some((t) => t.id === 't3')); // t3 está en z2
  });

  it('party size > max retorna vacío — invariante "una mesa"', () => {
    const candidates = getCandidateTables(ALL_TABLES, 20, null);
    assert.equal(candidates.length, 0);
  });

  it('countFreeTables cuenta mesas sin conflicto', () => {
    const start = new Date('2026-05-20T19:00:00Z');
    const end = new Date('2026-05-20T20:00:00Z');
    const reservations = parseReservations([
      { tableId: 't1', startUtc: '2026-05-20T19:00:00Z', durationMinutes: 60 },
    ]);
    const candidates = getCandidateTables(ALL_TABLES, 2, null);
    const free = countFreeTables(candidates, start, end, 0, reservations, [], null);
    // t1 ocupado, t3 libre → 1 libre en zona z1 candidatas (t1), pero t3 también candidato
    assert.equal(free, 1); // solo t3 libre para party size 2 (t1 y t3 admiten 2)
  });

  it('hold activo bloquea mesa', () => {
    const start = new Date('2026-05-20T19:00:00Z');
    const end = new Date('2026-05-20T20:00:00Z');
    const holds = parseHolds([
      { tableId: 't1', startUtc: '2026-05-20T19:00:00Z', durationMinutes: 60, holdToken: 'abc' },
    ]);
    const candidates = getCandidateTables(ALL_TABLES, 2, null);
    const free = countFreeTables(candidates, start, end, 0, [], holds, null);
    assert.equal(free, 1); // t1 bloqueado por hold, t3 libre
  });

  it('excludeHoldToken ignora el hold propio', () => {
    const start = new Date('2026-05-20T19:00:00Z');
    const end = new Date('2026-05-20T20:00:00Z');
    const holds = parseHolds([
      { tableId: 't1', startUtc: '2026-05-20T19:00:00Z', durationMinutes: 60, holdToken: 'abc' },
    ]);
    const candidates = getCandidateTables(ALL_TABLES, 2, null);
    const freeWithExclude = countFreeTables(candidates, start, end, 0, [], holds, 'abc');
    const freeWithout = countFreeTables(candidates, start, end, 0, [], holds, null);
    assert.ok(freeWithExclude > freeWithout); // excluir propio hold libera la mesa
  });

  it('checkPacing rechaza cuando se excede tope de personas', () => {
    const result = checkPacing(
      [{ dayOfWeek: null, maxCoversPerSlot: 10, maxReservationsPerSlot: null }],
      2, // dayOfWeek
      8, // confirmedCovers
      2, // confirmedReservations
      4  // requestedPartySize → 8+4=12 > 10
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pacing_covers_exceeded');
  });

  it('checkPacing pasa cuando hay espacio', () => {
    const result = checkPacing(
      [{ dayOfWeek: null, maxCoversPerSlot: 20, maxReservationsPerSlot: null }],
      2, 8, 2, 4
    );
    assert.equal(result.ok, true);
  });

  it('pickTable selecciona la mesa con menor slack', () => {
    const start = new Date('2026-05-20T19:00:00Z');
    const end = new Date('2026-05-20T20:00:00Z');
    const table = pickTable(ALL_TABLES, 2, start, end, 0, [], [], null, null);
    // Para partySize=2: t1 (slack=2), t3 (slack=6) → elige t1
    assert.equal(table?.id, 't1');
  });

  it('pickTable retorna null si todas ocupadas', () => {
    const start = new Date('2026-05-20T19:00:00Z');
    const end = new Date('2026-05-20T20:00:00Z');
    const reservations = parseReservations(ALL_TABLES.map((t) => ({
      tableId: t.id,
      startUtc: '2026-05-20T19:00:00Z',
      durationMinutes: 60,
    })));
    const table = pickTable(ALL_TABLES, 2, start, end, 0, reservations, [], null, null);
    assert.equal(table, null);
  });
});

// ─── policies.js ─────────────────────────────────────────────────────────────

describe('policies', () => {
  it('applyPolicies filtra por minimumNoticeMinutes en hoy', () => {
    const now = new Date('2026-05-20T18:00:00Z');
    const slots = [
      { time: '18:30', start: new Date('2026-05-20T18:30:00Z'), end: new Date('2026-05-20T19:30:00Z') },
      { time: '19:00', start: new Date('2026-05-20T19:00:00Z'), end: new Date('2026-05-20T20:00:00Z') },
      { time: '20:00', start: new Date('2026-05-20T20:00:00Z'), end: new Date('2026-05-20T21:00:00Z') },
    ];
    const filtered = applyPolicies(slots, {
      isToday: true,
      walkIn: false,
      nowDate: now,
      minimumNoticeMinutes: 60,
      parsedBlockedSlots: [],
    });
    // Debe requerir start >= 18:00 + 60min = 19:00
    assert.ok(!filtered.some((s) => s.time === '18:30'));
    assert.ok(filtered.some((s) => s.time === '19:00'));
    assert.ok(filtered.some((s) => s.time === '20:00'));
  });

  it('applyPolicies walk-in ignora minimumNoticeMinutes', () => {
    const now = new Date('2026-05-20T18:00:00Z');
    const slots = [
      { time: '18:00', start: new Date('2026-05-20T18:00:00Z'), end: new Date('2026-05-20T19:00:00Z') },
    ];
    const filtered = applyPolicies(slots, {
      isToday: true,
      walkIn: true,
      nowDate: now,
      minimumNoticeMinutes: 60,
      parsedBlockedSlots: [],
    });
    assert.equal(filtered.length, 1);
  });

  it('applyPolicies elimina cupos dentro de un bloqueo', () => {
    const blocked = parseBlockedSlots([
      { startUtc: '2026-05-20T19:00:00Z', endUtc: '2026-05-20T20:00:00Z' },
    ]);
    const slots = [
      { time: '18:00', start: new Date('2026-05-20T18:00:00Z'), end: new Date('2026-05-20T19:00:00Z') },
      { time: '19:00', start: new Date('2026-05-20T19:00:00Z'), end: new Date('2026-05-20T20:00:00Z') },
      { time: '20:00', start: new Date('2026-05-20T20:00:00Z'), end: new Date('2026-05-20T21:00:00Z') },
    ];
    const filtered = applyPolicies(slots, {
      isToday: false,
      walkIn: false,
      nowDate: new Date(),
      minimumNoticeMinutes: 0,
      parsedBlockedSlots: blocked,
    });
    assert.ok(!filtered.some((s) => s.time === '19:00'));
    assert.ok(filtered.some((s) => s.time === '18:00'));
    assert.ok(filtered.some((s) => s.time === '20:00'));
  });

  it('validateBookingPolicies rechaza reserva antes del límite de aviso', () => {
    const now = new Date('2026-05-20T18:00:00Z');
    const slotTime = new Date('2026-05-20T18:30:00Z'); // 30 min después, pero mínimo 60
    const result = validateBookingPolicies(slotTime, now, 60, 30);
    assert.equal(result.valid, false);
  });

  it('validateBookingPolicies rechaza reserva fuera del rango de días', () => {
    const now = new Date('2026-05-20T18:00:00Z');
    const slotTime = new Date('2026-06-25T18:00:00Z'); // > 30 días
    const result = validateBookingPolicies(slotTime, now, 60, 30);
    assert.equal(result.valid, false);
  });

  it('validateBookingPolicies walk-in ignora aviso mínimo', () => {
    const now = new Date('2026-05-20T18:00:00Z');
    const slotTime = new Date('2026-05-20T18:05:00Z'); // 5 min después
    const result = validateBookingPolicies(slotTime, now, 60, 30, true);
    assert.equal(result.valid, true);
  });
});

// ─── previewSlots ──────────────────────────────────────────────────────────────

describe('previewSlots', () => {
  it('genera preview correcto para config básica', () => {
    const slots = previewSlots({
      schedule: SCHEDULE_CONTINUOUS,
      scheduleMode: 'continuous',
      slotIntervalMinutes: 60,
      defaultSlotDurationMinutes: 60,
    });
    assert.deepEqual(slots, ['12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00']);
  });

  it('genera preview con intervalo 30min', () => {
    const slots = previewSlots({
      schedule: { scheduleMode: 'continuous', openTime: '19:00', closeTime: '21:00' },
      scheduleMode: 'continuous',
      slotIntervalMinutes: 30,
      defaultSlotDurationMinutes: 60,
    });
    assert.deepEqual(slots, ['19:00', '19:30', '20:00']);
  });

  it('genera preview con ventanas custom', () => {
    const slots = previewSlots({
      schedule: SCHEDULE_CONTINUOUS,
      scheduleMode: 'continuous',
      reservationWindowMode: 'custom',
      customWindows: [
        { startTime: '12:00', endTime: '14:00' },
        { startTime: '19:00', endTime: '21:00' },
      ],
      slotIntervalMinutes: 60,
      defaultSlotDurationMinutes: 60,
    });
    assert.deepEqual(slots, ['12:00', '13:00', '19:00', '20:00']);
  });

  it('aplica durationRules por partySize al calcular slots (afecta STRICT_END)', () => {
    // Con duración 90min y cierre 21:00, el último slot a las 19:30 debería caber (19:30+90=21:00)
    const slots = previewSlots({
      schedule: { scheduleMode: 'continuous', openTime: '19:00', closeTime: '21:00' },
      scheduleMode: 'continuous',
      slotIntervalMinutes: 30,
      defaultSlotDurationMinutes: 60,
      partySize: 4,
      durationRules: [{ minPartySize: 3, maxPartySize: 6, durationMinutes: 90 }],
    });
    assert.ok(slots.includes('19:30')); // 19:30 + 90min = 21:00 ok
    assert.ok(!slots.includes('20:00')); // 20:00 + 90min = 21:30 > 21:00
  });

  it('retorna array vacío para schedule null', () => {
    const slots = previewSlots({ schedule: null, slotIntervalMinutes: 60, defaultSlotDurationMinutes: 60 });
    assert.deepEqual(slots, []);
  });
});

// ─── validateSlotForBooking ────────────────────────────────────────────────────

describe('validateSlotForBooking', () => {
  const baseParams = {
    time: '19:00',
    partySize: 2,
    schedule: SCHEDULE_CONTINUOUS,
    restaurant: {
      scheduleMode: 'continuous',
      slotIntervalMinutes: 60,
      defaultSlotDurationMinutes: 60,
      reservationEndPolicy: 'STRICT_END',
      reservationWindowMode: 'same_as_schedule',
      bufferMinutesBetweenReservations: 0,
      minimumNoticeMinutes: 60,
      advanceBookingLimitDays: 30,
      holdsEnabled: true,
    },
    durationRules: [],
    customWindows: [],
    tables: ALL_TABLES,
    reservations: [],
    activeHolds: [],
    blockedSlots: [],
    pacingRules: [],
    slotDateTime: new Date('2026-05-25T22:00:00Z'), // 19:00 en -3
    now: new Date('2026-05-25T10:00:00Z'), // mucho antes
    isToday: false,
    walkIn: false,
    zoneId: null,
    excludeHoldToken: null,
    dayOfWeek: 1, // lunes
  };

  it('valida cupo correcto en grilla', () => {
    const result = validateSlotForBooking(baseParams);
    assert.equal(result.valid, true);
    assert.equal(result.durationMinutes, 60);
  });

  it('rechaza cupo fuera de grilla', () => {
    const result = validateSlotForBooking({ ...baseParams, time: '19:15' }); // 15 min, grilla 60
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'slot_not_on_grid');
  });

  it('acepta 01:00 en turno que cierra después de medianoche', () => {
    const schedule = {
      scheduleMode: 'continuous',
      openTime: '20:00',
      closeTime: '02:00',
      closesNextDay: true,
    };
    const result = validateSlotForBooking({
      ...baseParams,
      time: '01:00',
      schedule,
      restaurant: { ...baseParams.restaurant, scheduleMode: 'continuous' },
      slotDateTime: makeSlotDate('2026-05-26', '01:00'),
      isToday: false,
    });
    assert.equal(result.valid, true);
    assert.equal(result.durationMinutes, 60);
  });

  it('rechaza cuando no hay mesas para party size', () => {
    const result = validateSlotForBooking({ ...baseParams, partySize: 20 });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'party_size_exceeds_largest_table');
  });

  it('rechaza cuando mesa bloqueada por hold', () => {
    const holds = [
      { tableId: 't1', startUtc: '2026-05-25T22:00:00Z', durationMinutes: 60, holdToken: 'xyz' },
      { tableId: 't3', startUtc: '2026-05-25T22:00:00Z', durationMinutes: 60, holdToken: 'xyz2' },
    ];
    // Todas las mesas que admiten partySize=2 están en hold
    const result = validateSlotForBooking({ ...baseParams, activeHolds: holds });
    // t1 y t3 bloqueados por holds. t2 (5-6 cap) no admite party=2. Sin mesa disponible.
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'no_tables_available');
  });

  it('excluir propio hold libera la mesa', () => {
    const holds = [
      { tableId: 't1', startUtc: '2026-05-25T22:00:00Z', durationMinutes: 60, holdToken: 'myhold' },
      { tableId: 't3', startUtc: '2026-05-25T22:00:00Z', durationMinutes: 60, holdToken: 'xyz2' },
    ];
    // Con excludeHoldToken='myhold', t1 queda libre
    const result = validateSlotForBooking({ ...baseParams, activeHolds: holds, excludeHoldToken: 'myhold' });
    assert.equal(result.valid, true);
  });

  it('rechaza cupo bloqueado', () => {
    const blocked = [
      { startUtc: '2026-05-25T21:30:00Z', endUtc: '2026-05-25T23:00:00Z' },
    ];
    const result = validateSlotForBooking({ ...baseParams, blockedSlots: blocked });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'blocked');
  });

  it('no_schedule cuando no hay schedule', () => {
    const result = validateSlotForBooking({ ...baseParams, schedule: null });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'no_schedule');
  });
});

// ─── Invariante: una reserva = una mesa ─────────────────────────────────────

describe('invariante una reserva = una mesa', () => {
  const tables = [
    { id: 'a', zoneId: 'z1', minCapacity: 1, maxCapacity: 2, sortOrder: 0, zone: { id: 'z1', sortOrder: 0 } },
    { id: 'b', zoneId: 'z1', minCapacity: 3, maxCapacity: 4, sortOrder: 1, zone: { id: 'z1', sortOrder: 0 } },
  ];

  it('pickTable selecciona la mesa individual de menor tamaño válida', () => {
    const slotStart = new Date('2026-06-01T20:00:00Z');
    const slotEnd = new Date('2026-06-01T21:00:00Z');
    // (tables, partySize, slotStart, slotEnd, bufferMs, parsedReservations, parsedHolds, preferredZoneId)
    const t = pickTable(tables, 2, slotStart, slotEnd, 0, [], [], null);
    assert.equal(t.id, 'a'); // mesa a (1-2) es best fit para partySize=2
  });

  it('pickTable retorna null cuando group excede todas las mesas', () => {
    const slotStart = new Date('2026-06-01T20:00:00Z');
    const slotEnd = new Date('2026-06-01T21:00:00Z');
    const t = pickTable(tables, 10, slotStart, slotEnd, 0, [], [], null);
    assert.equal(t, null);
  });

  it('computeAvailability retorna reason party_size_exceeds_largest_table sin mesas válidas', () => {
    const { computeAvailability } = require('../index');
    const snapshot = {
      engineVersion: 3, date: '2099-06-15', timezone: 'UTC',
      subscriptionActive: true, isToday: false,
      serverNowUtc: new Date('2099-06-15T00:00:00Z').toISOString(),
      schedule: { scheduleMode: 'continuous', openTime: '12:00', closeTime: '22:00' },
      defaults: { slotIntervalMinutes: 60, slotDurationMinutes: 60, bufferMinutesBetweenReservations: 0, minimumNoticeMinutes: 0, advanceBookingLimitDays: 365 },
      durationRules: [], tables, zones: [], blockedSlots: [], reservations: [],
      activeHolds: [], pacingRules: [], reservationWindows: [], holdsEnabled: true,
    };
    const result = computeAvailability(snapshot, 20, null);
    assert.equal(result.slots.length, 0);
    assert.equal(result.reason, 'party_size_exceeds_largest_table');
  });
});

// ─── Pacing — límites por intervalo ─────────────────────────────────────────

describe('checkPacing', () => {
  // confirmedCovers=5 (2+3), confirmedReservations=2, requestedPartySize=2, dayOfWeek=1
  it('retorna ok cuando no hay regla de pacing', () => {
    const result = checkPacing([], 1, 5, 2, 2);
    assert.equal(result.ok, true);
  });

  it('bloquea cuando se supera maxReservationsPerSlot global', () => {
    const rules = [{ dayOfWeek: null, maxReservationsPerSlot: 2, maxCoversPerSlot: null }];
    const result = checkPacing(rules, 1, 5, 2, 2); // 2+1 > 2
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pacing_reservations_exceeded');
  });

  it('bloquea cuando se supera maxCoversPerSlot', () => {
    const rules = [{ dayOfWeek: null, maxReservationsPerSlot: null, maxCoversPerSlot: 6 }];
    const result = checkPacing(rules, 1, 5, 2, 2); // 5+2 > 6
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pacing_covers_exceeded');
  });

  it('no bloquea si hay cupo suficiente', () => {
    const rules = [{ dayOfWeek: null, maxReservationsPerSlot: 10, maxCoversPerSlot: 50 }];
    const result = checkPacing(rules, 1, 5, 2, 2);
    assert.equal(result.ok, true);
  });

  it('regla para día específico no aplica a otro día', () => {
    const rules = [{ dayOfWeek: 0, maxReservationsPerSlot: 1, maxCoversPerSlot: null }]; // domingo
    const result = checkPacing(rules, 1, 0, 0, 2); // lunes → no aplica
    assert.equal(result.ok, true);
  });
});
