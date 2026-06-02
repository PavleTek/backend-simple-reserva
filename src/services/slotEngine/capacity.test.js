'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickTable, parseReservations, msUntilNextReservation } = require('./capacity');

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
