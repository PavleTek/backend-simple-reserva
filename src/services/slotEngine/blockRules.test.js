'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  getDerivedBlockedTableIds,
  getRequiredLinkedTableIds,
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
});
