'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  getDerivedBlockedTableIds,
  getRequiredLinkedTableIds,
  applySwaps,
  ruleApplies,
} = require('./blockRules');
const { parseReservations, parseHolds } = require('./capacity');

const T = (offsetMin) => new Date(Date.UTC(2026, 5, 1, 20, 0, 0) + offsetMin * 60000);

describe('ruleApplies', () => {
  test('regla sin minPartySize aplica siempre', () => {
    assert.equal(ruleApplies({ minPartySize: null }, 2), true);
    assert.equal(ruleApplies({ minPartySize: null }, 200), true);
  });

  test('regla con minPartySize solo aplica si partySize cumple el umbral', () => {
    assert.equal(ruleApplies({ minPartySize: 20 }, 8), false);
    assert.equal(ruleApplies({ minPartySize: 20 }, 20), true);
    assert.equal(ruleApplies({ minPartySize: 20 }, 70), true);
  });
});

describe('applySwaps', () => {
  test('sin swaps retorna la misma lista', () => {
    assert.deepEqual(applySwaps(['a1', 'a2'], []), ['a1', 'a2']);
    assert.deepEqual(applySwaps(['a1', 'a2'], null), ['a1', 'a2']);
  });

  test('reemplaza solo las mesas con swap definido', () => {
    const swaps = [{ originalTableId: 'a1', substituteTableId: 'a6' }];
    assert.deepEqual(applySwaps(['a1', 'a2'], swaps), ['a6', 'a2']);
  });

  test('un swap que no matchea ninguna mesa de la lista no tiene efecto', () => {
    const swaps = [{ originalTableId: 'zzz', substituteTableId: 'a6' }];
    assert.deepEqual(applySwaps(['a1', 'a2'], swaps), ['a1', 'a2']);
  });
});

describe('getDerivedBlockedTableIds', () => {
  const blockRules = [
    { triggerTableId: 'mesa-evento', blockedTableId: 'a1', minPartySize: null },
    { triggerTableId: 'mesa-evento', blockedTableId: 'a2', minPartySize: null },
    { triggerTableId: 'mesa-evento', blockedTableId: 'b1', minPartySize: 20 },
  ];

  test('bloquea mesas vinculadas cuando la mesa gatillo tiene una reserva activa que solapa', () => {
    const reservations = parseReservations([
      { tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 70 },
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], blockRules, T(30), T(90));
    assert.deepEqual([...blocked].sort(), ['a1', 'a2', 'b1']);
  });

  test('regla con umbral no bloquea si la reserva del gatillo no lo alcanza', () => {
    const reservations = parseReservations([
      { tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 8 },
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], blockRules, T(30), T(90));
    assert.deepEqual([...blocked].sort(), ['a1', 'a2']);
  });

  test('no bloquea si el intervalo de la reserva gatillo no se solapa con el slot', () => {
    const reservations = parseReservations([
      { tableId: 'mesa-evento', startUtc: T(200).toISOString(), durationMinutes: 60, partySize: 70 },
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], blockRules, T(30), T(90));
    assert.equal(blocked.size, 0);
  });

  test('no se cascada: bloquear B no propaga el bloqueo de B hacia C', () => {
    const rules = [
      { triggerTableId: 'a', blockedTableId: 'b', minPartySize: null },
      { triggerTableId: 'b', blockedTableId: 'c', minPartySize: null },
    ];
    const reservations = parseReservations([
      { tableId: 'a', startUtc: T(0).toISOString(), durationMinutes: 60, partySize: 10 },
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], rules, T(0), T(60));
    assert.deepEqual([...blocked], ['b']);
    assert.equal(blocked.has('c'), false, 'C no debe bloquearse: solo reglas directas, sin cascada');
  });

  test('un hold activo en la mesa gatillo también bloquea sus mesas vinculadas', () => {
    const holds = parseHolds([
      {
        tableId: 'mesa-evento',
        startUtc: T(0).toISOString(),
        durationMinutes: 60,
        holdToken: 'hold-1',
        partySize: 70,
      },
    ]);
    const blocked = getDerivedBlockedTableIds([], holds, blockRules, T(0), T(60));
    assert.ok(blocked.has('a1'));
    assert.ok(blocked.has('b1'));
  });

  test('excludeHoldToken ignora el hold propio del usuario', () => {
    const holds = parseHolds([
      {
        tableId: 'mesa-evento',
        startUtc: T(0).toISOString(),
        durationMinutes: 60,
        holdToken: 'hold-1',
        partySize: 70,
      },
    ]);
    const blocked = getDerivedBlockedTableIds([], holds, blockRules, T(0), T(60), 'hold-1');
    assert.equal(blocked.size, 0);
  });

  test('sin blockRules retorna set vacío', () => {
    const blocked = getDerivedBlockedTableIds([], [], [], T(0), T(60));
    assert.equal(blocked.size, 0);
  });

  test('con swapsByReservationId, bloquea la mesa sustituta en vez de la original', () => {
    const reservations = parseReservations([
      { id: 'res-1', tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 70 },
    ]);
    const swapsByReservationId = new Map([
      ['res-1', [{ originalTableId: 'a1', substituteTableId: 'a6' }]],
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], blockRules, T(30), T(90), null, swapsByReservationId);
    assert.deepEqual([...blocked].sort(), ['a2', 'a6', 'b1']);
    assert.equal(blocked.has('a1'), false, 'a1 fue sustituida por a6 para esta reserva');
  });

  test('reserva sin entrada en swapsByReservationId bloquea la mesa por defecto', () => {
    const reservations = parseReservations([
      { id: 'res-1', tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 120, partySize: 70 },
    ]);
    const swapsByReservationId = new Map([
      ['otra-reserva', [{ originalTableId: 'a1', substituteTableId: 'a6' }]],
    ]);
    const blocked = getDerivedBlockedTableIds(reservations, [], blockRules, T(30), T(90), null, swapsByReservationId);
    assert.deepEqual([...blocked].sort(), ['a1', 'a2', 'b1']);
  });

  test('los holds nunca aplican swaps (no tienen reservationId persistido)', () => {
    const holds = parseHolds([
      { tableId: 'mesa-evento', startUtc: T(0).toISOString(), durationMinutes: 60, holdToken: 'hold-1', partySize: 70 },
    ]);
    const swapsByReservationId = new Map([
      ['hold-1', [{ originalTableId: 'a1', substituteTableId: 'a6' }]],
    ]);
    const blocked = getDerivedBlockedTableIds([], holds, blockRules, T(0), T(60), null, swapsByReservationId);
    assert.ok(blocked.has('a1'), 'un hold siempre bloquea la mesa por defecto, nunca una sustituta');
    assert.equal(blocked.has('a6'), false);
  });
});

describe('getRequiredLinkedTableIds', () => {
  const blockRules = [
    { triggerTableId: 'mesa-evento', blockedTableId: 'a1', minPartySize: null },
    { triggerTableId: 'mesa-evento', blockedTableId: 'b1', minPartySize: 20 },
  ];

  test('incluye reglas sin umbral y reglas cuyo umbral se cumple', () => {
    const required = getRequiredLinkedTableIds('mesa-evento', 70, blockRules);
    assert.deepEqual(required.sort(), ['a1', 'b1']);
  });

  test('excluye reglas cuyo umbral no se cumple', () => {
    const required = getRequiredLinkedTableIds('mesa-evento', 8, blockRules);
    assert.deepEqual(required, ['a1']);
  });

  test('mesa sin reglas como gatillo retorna vacío', () => {
    const required = getRequiredLinkedTableIds('otra-mesa', 70, blockRules);
    assert.deepEqual(required, []);
  });

  test('con swaps propuestos, sustituye la mesa vinculada por la mesa elegida para esta reserva', () => {
    const swaps = [{ originalTableId: 'a1', substituteTableId: 'a6' }];
    const required = getRequiredLinkedTableIds('mesa-evento', 70, blockRules, swaps);
    assert.deepEqual(required.sort(), ['a6', 'b1']);
  });

  test('un swap para una mesa que no es requerida no tiene efecto', () => {
    const swaps = [{ originalTableId: 'zzz', substituteTableId: 'a6' }];
    const required = getRequiredLinkedTableIds('mesa-evento', 70, blockRules, swaps);
    assert.deepEqual(required.sort(), ['a1', 'b1']);
  });
});
