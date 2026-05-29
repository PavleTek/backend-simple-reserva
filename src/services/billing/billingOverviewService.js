'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const { sortPlansByDisplayOrder } = require('../../lib/planDisplayOrder');
const { computePeriodEnd, estimateNextPaymentDate } = require('../../lib/billingPeriod');
const {
  getActiveSubscription,
  hasActiveAccess,
  isTrialing,
  getOrganizationWithTrial,
} = require('../subscriptionService');
const { formatPaymentMethodForApi } = require('./paymentMethodSnapshot');
const { fetchMpRetrySchedule } = require('./retryScheduleService');
const { PAYMENT_PROVIDER_MP_CHECKOUT_PRO } = require('../../lib/billingProviders');

const IVA_RATE = 0.19;

function priceWithIva(priceCLP) {
  const base = Number(priceCLP) || 0;
  const withIva = Math.round(base * (1 + IVA_RATE));
  return { base, withIva, ivaRate: IVA_RATE };
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const diff = new Date(isoDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

function isSamePlanRenewalScheduled(sub, scheduledSub) {
  if (!sub || !scheduledSub) return false;
  if (sub.status !== 'cancelled' || !sub.endDate || new Date() >= sub.endDate) return false;
  const skuA = sub.plan?.productSKU;
  const skuB = scheduledSub.plan?.productSKU;
  if (!skuA || !skuB || skuA !== skuB) return false;
  if (!scheduledSub.startDate || !sub.endDate) return false;
  const driftMs = Math.abs(
    new Date(scheduledSub.startDate).getTime() - new Date(sub.endDate).getTime(),
  );
  return driftMs <= 48 * 60 * 60 * 1000;
}

function buildAlerts(ctx) {
  const alerts = [];
  const {
    status,
    inGrace,
    gracePeriodEndsAt,
    cancelAtEndDate,
    scheduledPlanName,
    scheduledDate,
    renewalScheduledSamePlan,
    renewalScheduledAt,
    mpNextRetryAt,
    isPaused,
    pauseEndsAt,
    processingPayment,
  } = ctx;

  if (processingPayment) {
    alerts.push({
      type: 'recovery_in_progress',
      severity: 'info',
      message: 'Procesando tu pago... Esto puede tardar hasta 2 minutos.',
    });
  }
  if (isPaused && pauseEndsAt) {
    alerts.push({
      type: 'paused',
      severity: 'info',
      message: `Tu suscripción está pausada hasta el ${pauseEndsAt}.`,
      pauseEndsAt,
    });
  }
  if (inGrace) {
    const daysLeft = daysUntil(gracePeriodEndsAt);
    alerts.push({
      type: 'grace',
      severity: 'warning',
      message: `Cobro fallido. Tienes hasta el ${gracePeriodEndsAt?.slice(0, 10) ?? '—'} para regularizar${daysLeft != null ? ` (${daysLeft} día${daysLeft === 1 ? '' : 's'})` : ''}.`,
      gracePeriodEndsAt,
      mpNextRetryAt,
      daysLeft,
    });
  }
  if (renewalScheduledSamePlan && renewalScheduledAt) {
    alerts.push({
      type: 'renewal_scheduled',
      severity: 'info',
      message: `Renovación automática programada para el ${renewalScheduledAt.slice(0, 10)}.`,
      scheduledDate: renewalScheduledAt,
    });
  }
  if (scheduledPlanName && scheduledDate && !renewalScheduledSamePlan) {
    alerts.push({
      type: 'scheduled_change',
      severity: 'info',
      message: `Cambio al plan ${scheduledPlanName} programado para el ${scheduledDate.slice(0, 10)}.`,
      scheduledPlanName,
      scheduledDate,
    });
  }
  if (cancelAtEndDate && status !== 'expired') {
    alerts.push({
      type: 'cancel_at_end',
      severity: 'info',
      message: `Tu suscripción se cancelará el ${cancelAtEndDate.slice(0, 10)}. Mantienes acceso hasta esa fecha.`,
      cancelAtEndDate,
    });
  }
  if (status === 'trial' && ctx.trialEndsAt) {
    const trialDays = daysUntil(ctx.trialEndsAt);
    if (trialDays != null && trialDays <= 7) {
      alerts.push({
        type: 'trial_ending_soon',
        severity: 'warning',
        message: `Tu prueba termina en ${trialDays} día${trialDays === 1 ? '' : 's'}. Activa un plan para no perder el acceso.`,
        trialEndsAt: ctx.trialEndsAt,
      });
    }
  }
  if (status === 'expired') {
    alerts.push({
      type: 'expired',
      severity: 'danger',
      message: 'Tu suscripción venció. Elige un plan para reactivar el acceso.',
    });
  }
  return alerts;
}

async function getBillingOverview(organizationId, restaurantId) {
  const org = await getOrganizationWithTrial(organizationId);
  const sub = await getActiveSubscription(organizationId);
  const trialing = await isTrialing(organizationId);
  const hasAccess = await hasActiveAccess(organizationId);

  const inGrace = sub?.status === 'grace' && sub?.gracePeriodEndsAt && new Date() < sub.gracePeriodEndsAt;
  const cancelAtEndDate = sub?.status === 'cancelled' && sub?.endDate ? sub.endDate.toISOString() : null;

  let status;
  if (sub?.status === 'active') status = 'active';
  else if (inGrace) status = 'grace';
  else if (trialing) status = 'trial';
  else if (cancelAtEndDate) status = 'cancelled';
  else status = 'expired';

  let plan = sub?.plan || null;
  if (!plan && trialing) {
    const trialSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'trial' },
      include: { plan: true },
    });
    plan = trialSub?.plan || null;
  }
  if (!plan) {
    const orgWithPlan = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      include: { plan: true },
    });
    plan = orgWithPlan?.plan || null;
  }

  const planConfig = hasAccess ? await planService.resolvePlanConfigForRestaurant(restaurantId, true) : null;

  const scheduledSub = await prisma.subscription.findFirst({
    where: { organizationId, status: 'scheduled' },
    orderBy: { startDate: 'desc' },
    include: { plan: true },
  });

  const renewalScheduledSamePlan = isSamePlanRenewalScheduled(sub, scheduledSub);
  const renewalScheduledAt = renewalScheduledSamePlan ? scheduledSub.startDate.toISOString() : null;

  let scheduledPlanOut = scheduledSub?.plan?.productSKU ?? null;
  let scheduledPlanNameOut = scheduledSub?.plan?.name ?? null;
  let scheduledDateOut = scheduledSub?.startDate?.toISOString() ?? null;
  if (renewalScheduledSamePlan) {
    scheduledPlanOut = null;
    scheduledPlanNameOut = null;
    scheduledDateOut = null;
  }

  const nextPaymentDate =
    sub?.status === 'active' && sub.currentPeriodEnd
      ? sub.currentPeriodEnd.toISOString()
      : estimateNextPaymentDate(sub, planConfig);

  const price = priceWithIva(planConfig?.priceCLP ?? plan?.priceCLP ?? 0);

  let mpNextRetryAt = sub?.mpNextRetryAt?.toISOString?.() ?? null;
  if (inGrace && sub?.mercadopagoPreapprovalId && !mpNextRetryAt) {
    const retry = await fetchMpRetrySchedule(sub.mercadopagoPreapprovalId);
    if (retry?.nextRetryAt) {
      mpNextRetryAt = retry.nextRetryAt;
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { mpNextRetryAt: new Date(retry.nextRetryAt) },
      });
    }
  }

  const paymentMethod = formatPaymentMethodForApi(sub);
  const isCheckoutPro = sub?.paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO;

  const alerts = buildAlerts({
    status,
    inGrace,
    gracePeriodEndsAt: sub?.gracePeriodEndsAt?.toISOString?.() ?? null,
    cancelAtEndDate,
    scheduledPlanName: scheduledPlanNameOut,
    scheduledDate: scheduledDateOut,
    renewalScheduledSamePlan,
    renewalScheduledAt,
    mpNextRetryAt,
    isPaused: sub?.isPaused ?? false,
    pauseEndsAt: sub?.pauseEndsAt?.toISOString?.() ?? null,
    trialEndsAt: org?.trialEndsAt?.toISOString?.() ?? null,
    processingPayment: false,
  });

  const recentInvoices = await prisma.paymentReceipt.findMany({
    where: { organizationId },
    orderBy: { paymentDate: 'desc' },
    take: 3,
    include: { plan: { select: { name: true } } },
  });

  return {
    plan: {
      sku: plan?.productSKU ?? 'plan-basico',
      name: planConfig?.name ?? plan?.name ?? '—',
      priceCLP: price.base,
      priceWithIVA: price.withIva,
      ivaRate: price.ivaRate,
      billingFrequency: planConfig?.billingFrequency ?? plan?.billingFrequency ?? 1,
      billingFrequencyType: planConfig?.billingFrequencyType ?? plan?.billingFrequencyType ?? 'months',
      subscriptionStartDate: sub?.startDate?.toISOString?.() ?? null,
    },
    nextCharge: {
      amountCLP: price.base,
      amountWithIVA: price.withIva,
      currency: 'CLP',
      date: nextPaymentDate,
      daysUntil: daysUntil(nextPaymentDate),
      isAutomatic: !isCheckoutPro && sub?.paymentProvider === 'mercadopago_preapproval',
      isManual: isCheckoutPro,
      paymentMethod,
    },
    status,
    billingStatus: inGrace ? 'recovering' : status === 'active' ? 'healthy' : status === 'trial' ? 'healthy' : status === 'expired' ? 'expired' : 'expiring_soon',
    hasAccess,
    canActivate: status !== 'active',
    canReactivate: !!(sub?.status === 'cancelled' && sub?.endDate && new Date() < sub.endDate && !scheduledSub),
    trialEndsAt: org?.trialEndsAt?.toISOString?.() ?? null,
    cancelAtEndDate,
    currentPeriodEnd: cancelAtEndDate ?? nextPaymentDate,
    gracePeriodEndsAt: sub?.gracePeriodEndsAt?.toISOString?.() ?? null,
    paymentGracePeriod: inGrace,
    mpNextRetryAt,
    scheduledPlan: scheduledPlanOut,
    scheduledPlanName: scheduledPlanNameOut,
    scheduledDate: scheduledDateOut,
    renewalScheduledSamePlan,
    renewalScheduledAt,
    alerts,
    recentInvoices: recentInvoices.map((r) => ({
      id: r.id,
      paymentDate: r.paymentDate.toISOString(),
      amount: Number(r.amount),
      currency: r.currency,
      status: r.mercadopagoStatus ?? 'approved',
      planName: r.plan?.name ?? '—',
      receiptType: r.receiptType,
    })),
    billingEmail: org?.billingEmail ?? null,
    paymentProvider: sub?.paymentProvider ?? null,
  };
}

module.exports = {
  getBillingOverview,
  priceWithIva,
  buildAlerts,
};
