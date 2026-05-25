const test = require('node:test');
const assert = require('node:assert/strict');
const {
  roleHasPermission,
  assertHostReservationEditWindow,
  assertHostPartySizeIncrease,
} = require('./permissions');
const { ROLES } = require('./roles');

test('owner has all permissions', () => {
  assert.equal(roleHasPermission(ROLES.OWNER, 'billing.manage'), true);
  assert.equal(roleHasPermission(ROLES.OWNER, 'team.manage'), true);
});

test('host cannot manage billing or team', () => {
  assert.equal(roleHasPermission(ROLES.HOST, 'billing.view'), false);
  assert.equal(roleHasPermission(ROLES.HOST, 'team.manage'), false);
  assert.equal(roleHasPermission(ROLES.HOST, 'reservation.create'), true);
});

test('host can view schedules and zones but not edit config', () => {
  assert.equal(roleHasPermission(ROLES.HOST, 'schedule.view'), true);
  assert.equal(roleHasPermission(ROLES.HOST, 'zone.view'), true);
  assert.equal(roleHasPermission(ROLES.HOST, 'schedule.edit'), false);
  assert.equal(roleHasPermission(ROLES.HOST, 'table.structure.edit'), false);
});

test('host has no feedback access (view, settings, alerts)', () => {
  assert.equal(roleHasPermission(ROLES.HOST, 'feedback.view'), false);
  assert.equal(roleHasPermission(ROLES.HOST, 'feedback.settings'), false);
  assert.equal(roleHasPermission(ROLES.HOST, 'feedback.alerts.manage'), false);
});

test('manager can view feedback and manage alerts but not survey settings', () => {
  assert.equal(roleHasPermission(ROLES.MANAGER, 'feedback.view'), true);
  assert.equal(roleHasPermission(ROLES.MANAGER, 'feedback.alerts.manage'), true);
  assert.equal(roleHasPermission(ROLES.MANAGER, 'feedback.settings'), false);
});

test('manager can view billing but not implied manage via permission list', () => {
  assert.equal(roleHasPermission(ROLES.MANAGER, 'billing.view'), true);
  assert.equal(roleHasPermission(ROLES.MANAGER, 'menu.edit'), true);
});

test('host reservation edit window', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const inside = new Date('2026-05-22T14:00:00Z');
  const tooFar = new Date('2026-07-01T12:00:00Z');
  assert.equal(assertHostReservationEditWindow(inside, now).allowed, true);
  assert.equal(assertHostReservationEditWindow(tooFar, now).allowed, false);
});

test('host party size cap on increase', () => {
  assert.equal(assertHostPartySizeIncrease(4, 8).allowed, true);
  assert.equal(assertHostPartySizeIncrease(4, 14).allowed, false);
  assert.equal(assertHostPartySizeIncrease(14, 10).allowed, true);
});
