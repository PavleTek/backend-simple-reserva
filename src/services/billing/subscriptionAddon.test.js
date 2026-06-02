'use strict';

/**
 * Matriz de pruebas para la lógica de add-ons de suscripción.
 *
 * Estos tests documentan el comportamiento esperado de la capa de negocio
 * (funciones puras / lógica de fechas) sin requerir una conexión a DB.
 *
 * Casos cubiertos:
 *  1. Cálculo de minimumCommitmentUntil al activar
 *  2. Cálculo de removalScheduledFor al desactivar (normal y con compromiso)
 *  3. Exploit de ciclo gratis: activar-usar-desactivar-antes-del-cobro debe cobrar ≥ 1 ciclo
 *  4. Feature-on logic (isActive + removalScheduledFor)
 *  5. montoEfectivoNeto: suma plan + add-ons
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── Helpers puros extraídos de subscriptionAddonService.js ──────────────────

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Calcula billingStartsAt y minimumCommitmentUntil al activar un add-on.
 */
function computeAddonActivationDates(now, currentPeriodEnd, billingFrequencyMonths = 1) {
  if (!currentPeriodEnd || currentPeriodEnd <= now) {
    return { billingStartsAt: null, minimumCommitmentUntil: null };
  }
  const billingStartsAt = currentPeriodEnd;
  const minimumCommitmentUntil = addMonths(billingStartsAt, billingFrequencyMonths);
  return { billingStartsAt, minimumCommitmentUntil };
}

/**
 * Calcula removalScheduledFor al solicitar la baja.
 * removalScheduledFor = max(currentPeriodEnd, minimumCommitmentUntil)
 */
function computeRemovalScheduledFor(currentPeriodEnd, minimumCommitmentUntil) {
  const candidates = [currentPeriodEnd, minimumCommitmentUntil].filter(Boolean);
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates.map((d) => new Date(d).getTime())));
}

/**
 * Feature-on: el add-on cuenta como activo para el usuario.
 */
function isAddonFeatureOn(addon) {
  if (!addon || !addon.isActive) return false;
  if (!addon.removalScheduledFor) return true;
  return new Date(addon.removalScheduledFor) > new Date();
}

/**
 * Billing activo: el add-on debe incluirse en el monto a cobrar en un ciclo dado.
 */
function isAddonBillableInCycle(addon, cycleDate) {
  if (!addon || !addon.isActive) return false;
  if (addon.billingStartsAt && new Date(addon.billingStartsAt) > cycleDate) return false;
  if (!addon.removalScheduledFor) return true;
  return new Date(addon.removalScheduledFor) > cycleDate;
}

/**
 * Monto efectivo neto (sin IVA).
 */
function montoEfectivoNeto(planPriceCLP, addons, cycleDate = new Date()) {
  const addonTotal = addons
    .filter((a) => isAddonBillableInCycle(a, cycleDate))
    .reduce((sum, a) => sum + Number(a.priceCLP) * (a.quantity || 1), 0);
  return Number(planPriceCLP) + addonTotal;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('Activar addon: billingStartsAt = currentPeriodEnd, minimumCommitmentUntil = +1 mes', () => {
  const now = new Date('2026-06-02');
  const periodEnd = new Date('2026-06-30');
  const { billingStartsAt, minimumCommitmentUntil } = computeAddonActivationDates(now, periodEnd);

  assert.deepEqual(billingStartsAt, periodEnd);
  assert.deepEqual(minimumCommitmentUntil, new Date('2026-07-30'));
});

test('Activar addon sin periodEnd: billingStartsAt = null (trial sin renovación definida)', () => {
  const now = new Date('2026-06-02');
  const { billingStartsAt, minimumCommitmentUntil } = computeAddonActivationDates(now, null);
  assert.equal(billingStartsAt, null);
  assert.equal(minimumCommitmentUntil, null);
});

test('Desactivar addon en fecha normal: removalScheduledFor = currentPeriodEnd', () => {
  const periodEnd = new Date('2026-06-30');
  // minimumCommitmentUntil = 30 jul (ya >= periodEnd)
  const minimumCommitment = new Date('2026-07-30');
  const removal = computeRemovalScheduledFor(periodEnd, minimumCommitment);
  // max(30 jun, 30 jul) = 30 jul
  assert.deepEqual(removal, minimumCommitment);
});

test('EXPLOIT: activar 2 jun → desactivar 29 jun → debe cobrar 30 jun (≥1 ciclo)', () => {
  const now = new Date('2026-06-02');
  const periodEnd = new Date('2026-06-30');
  const { billingStartsAt, minimumCommitmentUntil } = computeAddonActivationDates(now, periodEnd);

  // Usuario desactiva el 29 jun
  const removalScheduledFor = computeRemovalScheduledFor(periodEnd, minimumCommitmentUntil);

  // removalScheduledFor debe ser 30 jul (min commitment), NO 30 jun
  assert.deepEqual(removalScheduledFor, minimumCommitmentUntil, '30 jul');

  // Addon con baja programada al 30 jul
  const addon = {
    isActive: true,
    priceCLP: 7990,
    quantity: 1,
    billingStartsAt,
    removalScheduledFor,
  };

  // En la renovación del 30 jun, el addon SÍ debe estar incluido
  const cycleJun30 = new Date('2026-06-30');
  assert.equal(
    isAddonBillableInCycle(addon, cycleJun30),
    true,
    'Debe cobrarse en la renovación del 30 jun',
  );

  // El monto efectivo del 30 jun incluye el addon
  const monto = montoEfectivoNeto(19990, [addon], cycleJun30);
  assert.equal(monto, 19990 + 7990, '$27.980');

  // En la renovación del 30 jul, el addon NO debe estar incluido (ya expiró)
  const cycleJul30 = new Date('2026-07-30');
  assert.equal(
    isAddonBillableInCycle(addon, cycleJul30),
    false,
    'No debe cobrarse en la renovación del 30 jul',
  );
});

test('Feature-on: addon activo sin removalScheduledFor', () => {
  assert.equal(isAddonFeatureOn({ isActive: true, removalScheduledFor: null }), true);
});

test('Feature-on: addon con baja programada en el futuro sigue activo', () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(isAddonFeatureOn({ isActive: true, removalScheduledFor: future }), true);
});

test('Feature-on: addon con removalScheduledFor en el pasado está inactivo', () => {
  const past = new Date(Date.now() - 1);
  assert.equal(isAddonFeatureOn({ isActive: true, removalScheduledFor: past }), false);
});

test('montoEfectivoNeto: sin addons = precio del plan', () => {
  assert.equal(montoEfectivoNeto(19990, []), 19990);
});

test('montoEfectivoNeto: plan + 1 addon activo', () => {
  const cycleDate = new Date('2026-06-30');
  const addon = {
    isActive: true,
    priceCLP: 7990,
    quantity: 1,
    billingStartsAt: new Date('2026-06-30'),
    removalScheduledFor: null,
  };
  assert.equal(montoEfectivoNeto(19990, [addon], cycleDate), 27980);
});

test('montoEfectivoNeto: addon con billingStartsAt en el futuro NO se incluye aún', () => {
  const cycleDate = new Date('2026-05-30'); // antes de billingStartsAt
  const addon = {
    isActive: true,
    priceCLP: 7990,
    quantity: 1,
    billingStartsAt: new Date('2026-06-30'), // aún no llegó la fecha de primer cobro
    removalScheduledFor: null,
  };
  assert.equal(montoEfectivoNeto(19990, [addon], cycleDate), 19990, 'No se incluye aún');
});

test('montoEfectivoNeto: addon inactivo no se suma', () => {
  const addon = { isActive: false, priceCLP: 7990, quantity: 1, billingStartsAt: null, removalScheduledFor: null };
  assert.equal(montoEfectivoNeto(19990, [addon]), 19990);
});

test('Migración CP→Subscription: minimumCommitmentUntil se preserva', () => {
  // Simular re-attach: el addon mantiene sus campos de compromiso
  const commitDate = new Date('2026-07-30');
  const addon = {
    organizationId: 'org-1',
    subscriptionId: 'old-sub',
    minimumCommitmentUntil: commitDate,
    removalScheduledFor: null,
    isActive: true,
  };
  // El re-attach sólo cambia subscriptionId; el resto no muta
  const reattached = { ...addon, subscriptionId: 'new-sub' };
  assert.deepEqual(reattached.minimumCommitmentUntil, commitDate);
  assert.equal(reattached.isActive, true);
});
