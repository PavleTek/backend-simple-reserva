'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const { computePeriodEnd } = require('../../lib/billingPeriod');
const { PAYMENT_PROVIDER_FLOW, PAYMENT_PROVIDER_MERCADOPAGO } = require('../../lib/billingDomain');

/**
 * Pure helper: what to do with the current paid sub when switching MP → Flow.
 * @param {{ status: string, currentPeriodEnd?: Date|null, startDate?: Date|null, gracePeriodEndsAt?: Date|null, plan?: object }} sub
 * @param {Date} [now]
 */
function decideSwitchToFlowSubUpdate(sub, now = new Date()) {
  if (!sub) return { kind: 'none' };
  const periodEnd = sub.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd)
    : (sub.plan ? computePeriodEnd(sub.startDate, sub.plan) : null);
  const inGrace = sub.status === 'grace';
  const hasAccess = sub.status === 'active' || inGrace
    || (sub.status === 'cancelled' && sub.endDate && new Date(sub.endDate) > now);

  if (!hasAccess) return { kind: 'flag_only' };

  const accessUntil = inGrace && sub.gracePeriodEndsAt
    ? new Date(sub.gracePeriodEndsAt)
    : (periodEnd || now);

  return {
    kind: 'cancel_keep_access',
    accessUntil,
    keepGraceEndsAt: inGrace ? (sub.gracePeriodEndsAt ? new Date(sub.gracePeriodEndsAt) : accessUntil) : accessUntil,
  };
}

async function switchOrganizationToFlow(organizationId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { id: true, paymentProvider: true },
  });
  if (!org) {
    const err = new Error('Organización no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (org.paymentProvider === PAYMENT_PROVIDER_FLOW) {
    return {
      paymentProvider: PAYMENT_PROVIDER_FLOW,
      alreadyFlow: true,
      cancelledPreapprovalId: null,
      accessUntil: null,
    };
  }

  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: { paymentProvider: PAYMENT_PROVIDER_FLOW },
  });

  await prisma.checkoutSession.updateMany({
    where: { organizationId, status: 'pending', paymentProvider: { not: PAYMENT_PROVIDER_FLOW } },
    data: { status: 'expired' },
  });

  const scheduledSubs = await prisma.subscription.findMany({
    where: { organizationId, status: 'scheduled' },
    select: { id: true, mercadopagoPreapprovalId: true },
  });
  const mercadopagoService = require('../mercadopagoService');
  for (const row of scheduledSubs) {
    if (row.mercadopagoPreapprovalId) {
      try {
        await mercadopagoService.cancelSubscription(row.mercadopagoPreapprovalId);
      } catch (err) {
        console.warn('[paymentProviderSwitch] scheduled MP cancel:', err?.message);
      }
    }
  }
  if (scheduledSubs.length) {
    await prisma.subscription.updateMany({
      where: { organizationId, status: 'scheduled' },
      data: {
        status: 'cancelled',
        isActiveSubscription: false,
        mercadopagoPreapprovalId: null,
      },
    });
  }

  const liveSub = await prisma.subscription.findFirst({
    where: {
      organizationId,
      status: { in: ['active', 'grace'] },
    },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });

  let cancelledPreapprovalId = null;
  let accessUntil = null;

  if (liveSub) {
    const decision = decideSwitchToFlowSubUpdate(liveSub);
    if (decision.kind === 'cancel_keep_access') {
      cancelledPreapprovalId = liveSub.mercadopagoPreapprovalId || null;
      accessUntil = decision.accessUntil;
      if (liveSub.mercadopagoPreapprovalId) {
        try {
          await mercadopagoService.cancelSubscription(liveSub.mercadopagoPreapprovalId);
        } catch (err) {
          console.warn('[paymentProviderSwitch] active MP cancel:', err?.message);
        }
      }
      await prisma.subscription.update({
        where: { id: liveSub.id },
        data: {
          status: 'cancelled',
          endDate: decision.accessUntil,
          currentPeriodEnd: decision.accessUntil,
          gracePeriodEndsAt: decision.keepGraceEndsAt,
          mercadopagoPreapprovalId: null,
          scheduledPlanId: null,
          scheduledChangeAt: null,
          planChangeWhen: null,
        },
      });
    }
  }

  planService.invalidateCache(organizationId);

  return {
    paymentProvider: PAYMENT_PROVIDER_FLOW,
    alreadyFlow: false,
    cancelledPreapprovalId,
    accessUntil: accessUntil ? accessUntil.toISOString() : null,
  };
}

async function switchOrganizationToMercadoPago(organizationId) {
  const liveFlow = await prisma.subscription.findFirst({
    where: {
      organizationId,
      flowSubscriptionId: { not: null },
      status: { in: ['active', 'grace', 'scheduled'] },
    },
    select: { id: true },
  });
  if (liveFlow) {
    const err = new Error(
      'No se puede volver a Mercado Pago mientras hay una suscripción Flow activa o programada.',
    );
    err.statusCode = 400;
    err.code = 'flow_subscription_active';
    throw err;
  }

  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: { paymentProvider: PAYMENT_PROVIDER_MERCADOPAGO },
  });
  planService.invalidateCache(organizationId);
  return { paymentProvider: PAYMENT_PROVIDER_MERCADOPAGO };
}

async function switchOrganizationPaymentProvider(organizationId, paymentProvider) {
  const next = String(paymentProvider || '').trim();
  if (next === PAYMENT_PROVIDER_FLOW) return switchOrganizationToFlow(organizationId);
  if (next === PAYMENT_PROVIDER_MERCADOPAGO) return switchOrganizationToMercadoPago(organizationId);
  const err = new Error('paymentProvider debe ser "flow" o "mercadopago"');
  err.statusCode = 400;
  throw err;
}

module.exports = {
  decideSwitchToFlowSubUpdate,
  switchOrganizationToFlow,
  switchOrganizationToMercadoPago,
  switchOrganizationPaymentProvider,
};
