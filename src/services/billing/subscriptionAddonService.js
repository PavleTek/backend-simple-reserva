'use strict';

/**
 * Gestión de add-ons de suscripción (org-scoped).
 *
 * Regla de negocio central (Opción C – compromiso mínimo de 1 ciclo):
 *   - Activar: feature disponible de inmediato; primer cobro al próximo ciclo.
 *     Se fija minimumCommitmentUntil = fin del primer ciclo facturado.
 *   - Desactivar: removalScheduledFor = max(currentPeriodEnd, minimumCommitmentUntil).
 *     Si el compromiso no se cumplió, igual se cobra ese primer ciclo.
 *
 * "Feature on" = isActive = true AND (removalScheduledFor IS NULL OR removalScheduledFor > now)
 */

const prisma = require('../../lib/prisma');
const { computePeriodEnd } = require('../../lib/billingPeriod');

const ADDON_EXPERIENCES = 'module_experiences';
const ADDON_PRICE_EXPERIENCES_CLP = 7990;

// ─── helpers de lectura ────────────────────────────────────────────────────

/**
 * Lista add-ons activos de la organización.
 * "Activo" = isActive=true AND feature no expiró aún.
 */
async function listActiveAddons(organizationId) {
  const now = new Date();
  return prisma.subscriptionAddon.findMany({
    where: {
      organizationId,
      isActive: true,
      OR: [
        { removalScheduledFor: null },
        { removalScheduledFor: { gt: now } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Devuelve el addon de un tipo específico para la org (el más reciente activo).
 */
async function getAddonByType(organizationId, addonType) {
  const now = new Date();
  return prisma.subscriptionAddon.findFirst({
    where: {
      organizationId,
      addonType,
      isActive: true,
      OR: [
        { removalScheduledFor: null },
        { removalScheduledFor: { gt: now } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * ¿El add-on de Experiences está activo para esta organización?
 */
async function isExperiencesAddonActive(organizationId) {
  const addon = await getAddonByType(organizationId, ADDON_EXPERIENCES);
  return addon !== null;
}

// ─── mutaciones ────────────────────────────────────────────────────────────

/**
 * Activa el add-on de Experiences para la organización.
 *
 * - Feature disponible de inmediato (isActive = true).
 * - billingStartsAt = currentPeriodEnd de la sub activa (primer cobro).
 * - minimumCommitmentUntil = billingStartsAt + duración de un ciclo
 *   (garantía de cobrar al menos 1 ciclo).
 *
 * Si ya existe un addon activo del mismo tipo, devuelve el existente sin crear otro.
 *
 * @param {{ organizationId: string, subscriptionId?: string }} opts
 * @returns {Promise<import('@prisma/client').SubscriptionAddon>}
 */
async function enableExperiencesAddon({ organizationId, subscriptionId }) {
  const existing = await getAddonByType(organizationId, ADDON_EXPERIENCES);
  if (existing) return existing;

  // Calcular fechas de compromiso basadas en la suscripción activa.
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true },
    include: { plan: true },
    orderBy: { startDate: 'desc' },
  });

  const now = new Date();
  let billingStartsAt = null;
  let minimumCommitmentUntil = null;

  if (sub) {
    // billingStartsAt = fin del período actual (próxima renovación).
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd)
      : (sub.plan ? computePeriodEnd(sub.startDate, sub.plan) : null);

    if (periodEnd && !Number.isNaN(periodEnd.getTime()) && periodEnd > now) {
      billingStartsAt = periodEnd;

      // minimumCommitmentUntil = billingStartsAt + 1 período de facturación.
      // Para planes mensuales (billingFrequency=1, billingFrequencyType='months'):
      const freq = sub.plan?.billingFrequency ?? 1;
      const freqType = sub.plan?.billingFrequencyType ?? 'months';
      const commitment = new Date(billingStartsAt);
      if (freqType === 'months') commitment.setMonth(commitment.getMonth() + freq);
      else if (freqType === 'days') commitment.setDate(commitment.getDate() + freq);
      else if (freqType === 'weeks') commitment.setDate(commitment.getDate() + freq * 7);
      else if (freqType === 'yearly') commitment.setFullYear(commitment.getFullYear() + 1);
      minimumCommitmentUntil = commitment;
    }
  }

  return prisma.subscriptionAddon.create({
    data: {
      organizationId,
      subscriptionId: subscriptionId || sub?.id || null,
      addonType: ADDON_EXPERIENCES,
      quantity: 1,
      priceCLP: ADDON_PRICE_EXPERIENCES_CLP,
      isActive: true,
      activatedAt: now,
      billingStartsAt,
      minimumCommitmentUntil,
      removalScheduledFor: null,
    },
  });
}

/**
 * Solicita la baja del add-on de Experiences.
 *
 * Regla: removalScheduledFor = max(currentPeriodEnd, minimumCommitmentUntil).
 * El add-on sigue activo (feature on) hasta esa fecha.
 *
 * @returns {{ addon, removalScheduledFor, message }}
 */
async function disableExperiencesAddon(organizationId) {
  const addon = await getAddonByType(organizationId, ADDON_EXPERIENCES);
  if (!addon) {
    const err = new Error('El módulo Actividades Pro no está activo.');
    err.statusCode = 404;
    throw err;
  }

  // Si ya hay una baja programada, devolver la existente.
  if (addon.removalScheduledFor) {
    return {
      addon,
      removalScheduledFor: addon.removalScheduledFor,
      message: `Actividades Pro ya tiene una baja programada para el ${addon.removalScheduledFor.toLocaleDateString('es-CL')}.`,
      alreadyScheduled: true,
    };
  }

  const now = new Date();

  // Obtener sub activa para saber el fin del período.
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true },
    include: { plan: true },
    orderBy: { startDate: 'desc' },
  });

  let currentPeriodEnd = null;
  if (sub) {
    currentPeriodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd)
      : (sub.plan ? computePeriodEnd(sub.startDate, sub.plan) : null);
  }

  // removalScheduledFor = max(currentPeriodEnd, minimumCommitmentUntil)
  const candidates = [currentPeriodEnd, addon.minimumCommitmentUntil].filter(
    (d) => d && !Number.isNaN(new Date(d).getTime()),
  );
  const removalScheduledFor = candidates.length
    ? new Date(Math.max(...candidates.map((d) => new Date(d).getTime())))
    : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // fallback: +30 días

  const updated = await prisma.subscriptionAddon.update({
    where: { id: addon.id },
    data: { removalScheduledFor },
  });

  const dateStr = removalScheduledFor.toLocaleDateString('es-CL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const message =
    removalScheduledFor > (currentPeriodEnd || now)
      ? `Actividades Pro seguirá activo y se cobrará al menos un ciclo (hasta el ${dateStr}) porque se activó durante el período actual.`
      : `Actividades Pro se desactivará el ${dateStr} al finalizar tu ciclo de facturación actual.`;

  return { addon: updated, removalScheduledFor, message };
}

/**
 * Cancela una baja programada del add-on de Experiences.
 * Limpia removalScheduledFor; el add-on sigue activo con normalidad.
 *
 * @returns {{ addon, message, alreadyCancelled?: boolean }}
 */
async function cancelExperiencesAddonRemoval(organizationId) {
  const addon = await getAddonByType(organizationId, ADDON_EXPERIENCES);
  if (!addon) {
    const err = new Error('El módulo Actividades Pro no está activo.');
    err.statusCode = 404;
    throw err;
  }

  if (!addon.removalScheduledFor) {
    return {
      addon,
      message: 'Actividades Pro no tiene una baja programada.',
      alreadyCancelled: true,
    };
  }

  const updated = await prisma.subscriptionAddon.update({
    where: { id: addon.id },
    data: { removalScheduledFor: null },
  });

  return {
    addon: updated,
    message: 'Baja cancelada. Actividades Pro seguirá activo en tu suscripción.',
  };
}

/**
 * Procesa bajas programadas cuya fecha ya pasó (llamado por cron/renovación).
 * Apaga isActive en addons con removalScheduledFor <= now.
 */
async function processDueAddonRemovals() {
  const now = new Date();
  const due = await prisma.subscriptionAddon.findMany({
    where: {
      isActive: true,
      removalScheduledFor: { lte: now },
    },
  });

  for (const addon of due) {
    await prisma.subscriptionAddon.update({
      where: { id: addon.id },
      data: { isActive: false },
    });
  }

  return due.length;
}

/**
 * Re-apunta subscriptionId al crear una nueva Subscription (migración CP↔Automatic).
 * Preserva minimumCommitmentUntil y removalScheduledFor.
 */
async function reattachAddonsToSubscription(organizationId, newSubscriptionId) {
  await prisma.subscriptionAddon.updateMany({
    where: {
      organizationId,
      isActive: true,
      OR: [
        { removalScheduledFor: null },
        { removalScheduledFor: { gt: new Date() } },
      ],
    },
    data: { subscriptionId: newSubscriptionId },
  });
}

module.exports = {
  ADDON_EXPERIENCES,
  ADDON_PRICE_EXPERIENCES_CLP,
  listActiveAddons,
  getAddonByType,
  isExperiencesAddonActive,
  enableExperiencesAddon,
  disableExperiencesAddon,
  cancelExperiencesAddonRemoval,
  processDueAddonRemovals,
  reattachAddonsToSubscription,
};
