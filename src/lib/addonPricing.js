'use strict';

/**
 * Helpers de precios efectivos con add-ons.
 *
 * montoEfectivoNeto(organizationId, planPriceCLP) devuelve el monto neto
 * (sin IVA) = plan + suma de add-ons activos pagables en el próximo ciclo.
 *
 * La regla de "activo pagable" es:
 *   isActive = true
 *   AND (billingStartsAt IS NULL OR billingStartsAt <= referenceDate)
 *   AND (removalScheduledFor IS NULL OR removalScheduledFor > referenceDate)
 *
 * Mientras no existan esas columnas en la DB (previo a la migración
 * addon-org-scoped), el query sólo filtra isActive = true y la función
 * cae back a comportamiento seguro.
 */

const prisma = require('./prisma');

/**
 * Suma el monto neto de add-ons activos y pagables para la organización.
 *
 * @param {string} organizationId
 * @param {Date} [referenceDate=new Date()] - fecha de referencia (suele ser el
 *   inicio del ciclo de facturación a cobrar, i.e. currentPeriodEnd).
 * @returns {Promise<number>} suma en CLP (entero, sin IVA)
 */
async function getActiveAddonTotal(organizationId, referenceDate = new Date()) {
  const now = referenceDate;

  // Construcción del filtro de forma defensiva: si los campos aún no existen en
  // el schema (migración pendiente), Prisma lanzará un error → capturamos y
  // devolvemos 0 para no bloquear el flujo de billing.
  let addons;
  try {
    addons = await prisma.subscriptionAddon.findMany({
      where: {
        organizationId,
        isActive: true,
        AND: [
          {
            OR: [
              { billingStartsAt: null },
              { billingStartsAt: { lte: now } },
            ],
          },
          {
            OR: [
              { removalScheduledFor: null },
              { removalScheduledFor: { gt: now } },
            ],
          },
        ],
      },
      select: { priceCLP: true, quantity: true },
    });
  } catch (_err) {
    // Campos aún no migrados — usar filtro mínimo sólo con isActive.
    addons = await prisma.subscriptionAddon.findMany({
      where: { organizationId, isActive: true },
      select: { priceCLP: true, quantity: true },
    });
  }

  return addons.reduce(
    (sum, a) => sum + Number(a.priceCLP) * (a.quantity || 1),
    0,
  );
}

/**
 * Monto neto efectivo = planPriceCLP + add-ons activos.
 *
 * @param {string} organizationId
 * @param {number|string} planPriceCLP - precio neto del plan (sin IVA)
 * @param {Date} [referenceDate]
 * @returns {Promise<number>}
 */
async function montoEfectivoNeto(organizationId, planPriceCLP, referenceDate) {
  const addonTotal = await getActiveAddonTotal(organizationId, referenceDate);
  return Number(planPriceCLP) + addonTotal;
}

/**
 * Verifica si un add-on específico está activo para la organización.
 * Feature on = isActive && no expiró (removalScheduledFor en el futuro o null).
 *
 * @param {string} organizationId
 * @param {string} addonType  e.g. 'module_experiences'
 * @returns {Promise<boolean>}
 */
async function isAddonActive(organizationId, addonType) {
  const now = new Date();
  try {
    const addon = await prisma.subscriptionAddon.findFirst({
      where: {
        organizationId,
        addonType,
        isActive: true,
        OR: [
          { removalScheduledFor: null },
          { removalScheduledFor: { gt: now } },
        ],
      },
    });
    return addon !== null;
  } catch (_err) {
    // Migración pendiente — fallback a isActive sólo.
    const addon = await prisma.subscriptionAddon.findFirst({
      where: { organizationId, addonType, isActive: true },
    });
    return addon !== null;
  }
}

module.exports = { getActiveAddonTotal, montoEfectivoNeto, isAddonActive };
