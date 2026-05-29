/**
 * Lógica de reparación de suscripciones (admin) y helpers testeables.
 */

const prisma = require('../lib/prisma');
const { computePeriodEnd } = require('../lib/billingPeriod');
const {
  computeDefaultTrialEndsAt,
  isTrialExpired,
} = require('../lib/trialPeriod');

const MP_AUTHORIZED = new Set(['authorized', 'approved']);
const UNPAID_STATUSES = new Set(['trial', 'expired']);

function defaultTrialEndsAt(createdAt) {
  return computeDefaultTrialEndsAt(createdAt);
}

/**
 * @param {string} status
 * @param {boolean} mpAuthorized
 * @param {string|null} preapprovalId
 */
function shouldManageBillingPeriod(status, mpAuthorized, preapprovalId) {
  if (status === 'active') return true;
  return mpAuthorized && !!preapprovalId;
}

/**
 * @param {string} status
 * @param {boolean} mpAuthorized
 */
function shouldClearBillingPeriod(status, mpAuthorized) {
  return UNPAID_STATUSES.has(status) && !mpAuthorized;
}

/**
 * @param {Date|null|undefined} trialEndsAt
 * @param {Date} createdAt
 */
function resolveTrialEndsAt(trialEndsAt, createdAt) {
  if (trialEndsAt) return new Date(trialEndsAt);
  return defaultTrialEndsAt(createdAt);
}

/**
 * @param {Date} trialEndsAt
 */
function isTrialPast(trialEndsAt) {
  return isTrialExpired(trialEndsAt);
}

/**
 * @param {string} line
 * @returns {{ type: 'ok' | 'skip' | 'error', message: string }}
 */
function classifyRepairLogLine(line) {
  const lower = line.toLowerCase();
  if (lower.includes('fallido') || lower.includes('fallida') || lower.includes('error')) {
    return { type: 'error', message: line };
  }
  if (
    lower.includes('omitido')
    || lower.includes('no se recalcula')
    || lower.includes('conservado')
    || lower.includes('sin cambios')
    || lower.includes('no aplica')
  ) {
    return { type: 'skip', message: line };
  }
  return { type: 'ok', message: line };
}

/**
 * Busca un preapproval autorizado en MP para la org (sub o checkout reciente).
 * @returns {Promise<{ preapprovalId: string, mpStatus: string } | null>}
 */
async function findAuthorizedPreapprovalForOrg(organizationId, existingPreapprovalId) {
  const { getMercadoPagoAccessToken } = require('../lib/mercadopagoEnv');
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) return null;

  const { MercadoPagoConfig, PreApproval } = require('mercadopago');
  const mpClient = new MercadoPagoConfig({ accessToken });
  const preApprovalClient = new PreApproval(mpClient);

  const candidates = [];
  if (existingPreapprovalId) {
    candidates.push(existingPreapprovalId);
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sessions = await prisma.checkoutSession.findMany({
    where: {
      organizationId,
      createdAt: { gt: since },
      mercadopagoPreapprovalId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  for (const s of sessions) {
    if (s.mercadopagoPreapprovalId && !candidates.includes(s.mercadopagoPreapprovalId)) {
      candidates.push(s.mercadopagoPreapprovalId);
    }
  }

  for (const id of candidates) {
    try {
      const mpSub = await preApprovalClient.get({ id });
      const mpStatus = mpSub?.status ?? null;
      if (mpStatus && MP_AUTHORIZED.has(mpStatus)) {
        return { preapprovalId: id, mpStatus };
      }
    } catch {
      // siguiente candidato
    }
  }

  if (existingPreapprovalId) {
    try {
      const mpSub = await preApprovalClient.get({ id: existingPreapprovalId });
      const mpStatus = mpSub?.status ?? null;
      return { preapprovalId: existingPreapprovalId, mpStatus: mpStatus ?? 'desconocido' };
    } catch (e) {
      return { preapprovalId: existingPreapprovalId, mpStatus: null, error: e?.message };
    }
  }

  return null;
}

const fullSubscriptionInclude = {
  plan: true,
  organization: {
    select: {
      id: true,
      name: true,
      trialEndsAt: true,
      createdAt: true,
      restaurants: { select: { name: true } },
    },
  },
};

/**
 * Repara una suscripción por id.
 * @param {string} subscriptionId
 * @param {{ force?: boolean }} options
 */
async function repairSubscription(subscriptionId, options = {}) {
  const log = [];
  let sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      plan: true,
      organization: {
        select: { id: true, trialEndsAt: true, createdAt: true },
      },
    },
  });
  if (!sub) {
    const err = new Error('Suscripción no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const org = sub.organization;
  const force = Boolean(options.force);

  // --- MP: activar si hay preapproval autorizado ---
  let mpAuthorized = false;
  let mpLookup = await findAuthorizedPreapprovalForOrg(
    sub.organizationId,
    sub.mercadopagoPreapprovalId,
  );

  if (mpLookup?.mpStatus && MP_AUTHORIZED.has(mpLookup.mpStatus)) {
    mpAuthorized = true;
    const mercadopagoService = require('./mercadopagoService');
    try {
      const result = await mercadopagoService.confirmSubscriptionFromPreapproval(
        sub.organizationId,
        mpLookup.preapprovalId,
      );
      if (result.activated) {
        log.push(`Suscripción activada desde MP (preapproval ${mpLookup.preapprovalId})`);
      } else if (result.scheduled) {
        log.push(`Suscripción programada desde MP para ${result.scheduledDate ?? 'fecha futura'}`);
      } else {
        log.push(`MP autorizado pero sin activación: ${result.reason ?? 'sin detalle'}`);
      }
      // Recargar la fila activa más reciente de la org (activate puede crear nueva sub)
      const latest = await prisma.subscription.findFirst({
        where: { organizationId: sub.organizationId },
        orderBy: { createdAt: 'desc' },
        include: fullSubscriptionInclude,
      });
      if (latest) {
        sub = latest;
        org = latest.organization ?? org;
        mpAuthorized = latest.status === 'active' || MP_AUTHORIZED.has(mpLookup.mpStatus);
      }
    } catch (mpErr) {
      log.push(`MP activación fallida (no bloqueante): ${mpErr?.message ?? mpErr}`);
    }
  } else if (mpLookup?.mpStatus) {
    log.push(`MP preapproval status: ${mpLookup.mpStatus}`);
    if (mpLookup.mpStatus === 'cancelled' || mpLookup.mpStatus === 'expired') {
      if (sub.isActiveSubscription && sub.status === 'active') {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { isActiveSubscription: false },
        });
        log.push(`acceso revocado por MP status: ${mpLookup.mpStatus}`);
        sub = await prisma.subscription.findUnique({
          where: { id: sub.id },
          include: { plan: true, organization: { select: { id: true, trialEndsAt: true, createdAt: true } } },
        });
      }
    }
  } else if (sub.mercadopagoPreapprovalId) {
    log.push('MP sync omitido: no se pudo consultar preapproval');
  }

  const updates = {};
  const managePeriod = shouldManageBillingPeriod(sub.status, mpAuthorized, sub.mercadopagoPreapprovalId);
  const clearPeriod = shouldClearBillingPeriod(sub.status, mpAuthorized);

  if (clearPeriod && sub.currentPeriodEnd) {
    updates.currentPeriodEnd = null;
    log.push('currentPeriodEnd eliminado (no aplica sin plan de pago)');
  } else if (managePeriod && sub.plan && (!sub.currentPeriodEnd || force)) {
    const refDate = sub.startDate ?? new Date();
    const periodEnd = computePeriodEnd(refDate, sub.plan);
    if (periodEnd) {
      updates.currentPeriodEnd = periodEnd;
      log.push(`currentPeriodEnd recalculado: ${periodEnd.toISOString()}`);
    }
  } else if (!managePeriod) {
    log.push('Ciclo de cobro omitido: suscripción en prueba o sin pago en MP');
  } else if (sub.currentPeriodEnd && !force) {
    log.push('currentPeriodEnd conservado (usa forzar recálculo si necesitas actualizarlo)');
  }

  // --- Expirar trial vencido ---
  if (sub.status === 'trial') {
    const trialEnds = resolveTrialEndsAt(org.trialEndsAt, org.createdAt);
    if (!org.trialEndsAt) {
      await prisma.restaurantOrganization.update({
        where: { id: sub.organizationId },
        data: { trialEndsAt: trialEnds },
      });
      log.push(`trialEndsAt restaurado desde alta: ${trialEnds.toISOString()}`);
    }

    if (isTrialPast(trialEnds)) {
      updates.status = 'expired';
      updates.isActiveSubscription = false;
      log.push('Trial vencido: suscripción marcada como expired sin acceso');
    } else {
      log.push('trialEndsAt conservado (prueba aún vigente)');
    }
  }

  let updated;
  if (Object.keys(updates).length > 0) {
    updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: updates,
      include: fullSubscriptionInclude,
    });
  } else {
    updated = await prisma.subscription.findUnique({
      where: { id: sub.id },
      include: fullSubscriptionInclude,
    });
  }

  const finalStatus = updated?.status ?? sub.status;
  if (finalStatus === 'active') {
    await prisma.restaurantOrganization.update({
      where: { id: sub.organizationId },
      data: { trialEndsAt: null },
    }).catch(() => {});
    log.push('trialEndsAt limpiado en organización (plan de pago activo)');
    updated = await prisma.subscription.findUnique({
      where: { id: updated.id },
      include: fullSubscriptionInclude,
    });
  } else if (sub.status === 'trial' && !updates.status) {
    // ya logueado arriba
  }

  const orgRow = await prisma.restaurantOrganization.findUnique({
    where: { id: sub.organizationId },
    select: { trialEndsAt: true },
  });

  return {
    subscription: updated,
    log,
    organization: {
      trialEndsAt: orgRow?.trialEndsAt?.toISOString() ?? null,
    },
  };
}

module.exports = {
  defaultTrialEndsAt,
  shouldManageBillingPeriod,
  shouldClearBillingPeriod,
  resolveTrialEndsAt,
  isTrialPast,
  classifyRepairLogLine,
  repairSubscription,
};
