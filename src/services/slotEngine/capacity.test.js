'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickTable, countFreeTables, parseReservations, parseHolds, msUntilNextReservation } = require('./capacity');

function makeTable(id, capacity, sortOrder = 0) {
  return {
    id,
    zoneId: 'z1',
    minCapacity: 1,
    maxCapacity: capacity,
    sortOrder,
    zone: { id: 'z1', sortOrder: 0 },
  };
}

const T = (offsetMin) => new Date(Date.UTC(2026, 5, 1, 22, 0, 0) + offsetMin * 60000);

describe('pickTable', () => {
  test('asigna mesa sin reservas próximas antes que mesa con reserva inminente (preferOpenEnded)', () => {
    const mesa1 = makeTable('mesa-1', 4, 1); // tiene reserva confirmed a los 60 min
    const mesa2 = makeTable('mesa-2', 4, 2); // libre todo el día

    // Walk-in a las 22:00, duración 60 min → slot [22:00, 23:00)
    const slotStart = T(0);
    const slotEnd = T(60);
    const bufferMs = 0;

    // Reserva de Alberto en mesa-1 a las 23:00 (justo al final del walk-in)
    const parsedRes = parseReservations([
      { tableId: 'mesa-1', startUtc: T(60).toISOString(), durationMinutes: 90 },
    ]);

    // Sin preferOpenEnded → elige mesa-1 (menor sortOrder)
    const sinPreferencia = pickTable(
      [mesa1, mesa2], 2, slotStart, slotEnd, bufferMs, parsedRes, [], null, null,
      { preferOpenEnded: false }
    );
    assert.equal(sinPreferencia.id, 'mesa-1', 'Sin preferOpenEnded elige menor sortOrder');

    // Con preferOpenEnded → elige mesa-2 (más tiempo libre después del slot)
    const conPreferencia = pickTable(
      [mesa1, mesa2], 2, slotStart, slotEnd, bufferMs, parsedRes, [], null, null,
      { preferOpenEnded: true }
    );
    assert.equal(conPreferencia.id, 'mesa-2', 'Con preferOpenEnded evita mesa con reserva inminente');
  });

  test('bloquea mesa con reserva arrived que solapa el nuevo slot (fix bug confirmed-only)', () => {
    const mesa = makeTable('mesa-1', 4);
    // Walk-in arrived 21:00–22:30 en mesa-1
    const parsedRes = parseReservations([
      { tableId: 'mesa-1', startUtc: T(-60).toISOString(), durationMinutes: 90 },
    ]);
    // Intentar asignar nueva reserva 22:00–23:00 a mesa-1
    const result = pickTable(
      [mesa], 2, T(0), T(60), 0, parsedRes, [], null, null
    );
    assert.equal(result, null, 'Mesa con arrived solapado debe estar bloqueada');
  });
});

describe('mesas vinculadas (TableBlockRule)', () => {
  const mesaEvento = makeTable('mesa-evento', 300, 1);
  const a1 = makeTable('a1', 6, 2);
  const a2 = makeTable('a2', 6, 3);
  const blockRules = [
    { triggerTableId: 'mesa-evento', blockedTableId: 'a1', minPartySize: null },
    { triggerTableId: 'mesa-evento', blockedTableId: 'a2', minPartySize: 20 },
  ];

  test('countFreeTables: mesa vinculada queda ocupada mientras la mesa gatillo tiene una reserva activa', () => {
    const parsedRes = parseReservations([
      { tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 70 },
    ]);
    const free = countFreeTables(
      [a1], T(30), T(90), 0, parsedRes, [], null, [],
      { partySize: 6, blockRules, allTables: [mesaEvento, a1, a2] }
    );
    assert.equal(free, 0, 'a1 debe estar bloqueada por la reserva de mesa-evento');
  });

  test('countFreeTables: mesa vinculada con umbral no se bloquea si la reserva del gatillo es chica', () => {
    const parsedRes = parseReservations([
      { tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 8 },
    ]);
    const free = countFreeTables(
      [a2], T(30), T(90), 0, parsedRes, [], null, [],
      { partySize: 4, blockRules, allTables: [mesaEvento, a1, a2] }
    );
    assert.equal(free, 1, 'a2 solo se bloquea si la reserva del gatillo alcanza 20 personas');
  });

  test('pickTable es recíproco: la mesa gatillo no está disponible si una mesa vinculada requerida está ocupada', () => {
    // a1 tiene una reserva directa que solapa el slot deseado.
    const parsedRes = parseReservations([
      { tableId: 'a1', startUtc: T(0).toISOString(), durationMinutes: 90, partySize: 4 },
    ]);
    const selected = pickTable(
      [mesaEvento, a1, a2], 70, T(0), T(90), 0, parsedRes, [], null, null,
      { blockRules }
    );
    assert.equal(selected, null, 'mesa-evento requiere a1 y a2 libres para 70 personas; a1 está ocupada');
  });

  test('pickTable acepta la mesa gatillo cuando todas sus mesas vinculadas requeridas están libres', () => {
    const selected = pickTable(
      [mesaEvento, a1, a2], 70, T(0), T(90), 0, [], [], null, null,
      { blockRules }
    );
    assert.equal(selected?.id, 'mesa-evento');
  });

  test('pickTable: por debajo del umbral, la regla de a2 no aplica y no bloquea la mesa gatillo', () => {
    const parsedRes = parseReservations([
      { tableId: 'a2', startUtc: T(0).toISOString(), durationMinutes: 90, partySize: 4 },
    ]);
    // Party size 8 < minPartySize 20 de la regla hacia a2 → a2 no es requerida, solo a1.
    const selected = pickTable(
      [mesaEvento, a1, a2], 8, T(0), T(90), 0, parsedRes, [], null, null,
      { blockRules }
    );
    assert.equal(selected?.id, 'mesa-evento');
  });

  test('un hold activo en la mesa vinculada también bloquea la mesa gatillo (bidireccional)', () => {
    const parsedHolds = parseHolds([
      { tableId: 'a1', startUtc: T(0).toISOString(), durationMinutes: 90, holdToken: 'h1', partySize: 4 },
    ]);
    const selected = pickTable(
      [mesaEvento, a1, a2], 70, T(0), T(90), 0, [], parsedHolds, null, null,
      { blockRules }
    );
    assert.equal(selected, null);
  });

  test('sin blockRules, comportamiento idéntico al motor v3 (sin cambios)', () => {
    const selected = pickTable(
      [mesaEvento, a1, a2], 70, T(0), T(90), 0, [], [], null, null,
      {}
    );
    assert.equal(selected?.id, 'mesa-evento');
  });
});

describe('msUntilNextReservation', () => {
  test('retorna Infinity si no hay reservas futuras', () => {
    const parsedRes = parseReservations([
      { tableId: 'mesa-1', startUtc: T(-30).toISOString(), durationMinutes: 30 },
    ]);
    const gap = msUntilNextReservation('mesa-1', T(0), parsedRes);
    assert.equal(gap, Infinity);
  });

  test('retorna ms hasta la próxima reserva futura', () => {
    const parsedRes = parseReservations([
      { tableId: 'mesa-1', startUtc: T(90).toISOString(), durationMinutes: 60 },
    ]);
    const gap = msUntilNextReservation('mesa-1', T(60), parsedRes);
    assert.equal(gap, 30 * 60000, '30 min en ms');
  });
});
