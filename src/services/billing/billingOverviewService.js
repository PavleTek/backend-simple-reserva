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
const { subscriptionBillingView } = require('../../lib/billingDomain');
const {
  buildPendingChange,
  buildBillingCapabilities,
  buildEntitlementBlock,
  isSamePlanRenewalScheduled,
} = require('./billingContractService');

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
      gracePeriodEndsAt,
      mpNextRetryAt,
      daysLeft,
    });
  }
  if (renewalScheduledSamePlan && renewalScheduledAt) {
    alerts.push({
      type: 'renewal_scheduled',
      severity: 'info',
      scheduledDate: renewalScheduledAt,
    });
  }
  if (scheduledPlanName && scheduledDate && !renewalScheduledSamePlan) {
    alerts.push({
      type: 'scheduled_change',
      severity: 'info',
      scheduledPlanName,
      scheduledDate,
    });
  }
  if (cancelAtEndDate && status !== 'expired') {
    alerts.push({
      type: 'cancel_at_end',
      severity: 'info',
      cancelAtEndDate,
    });
  }
  if (status === 'trial' && ctx.trialEndsAt) {
    const trialDays = daysUntil(ctx.trialEndsAt);
    if (trialDays != null && trialDays <= 7) {
      alerts.push({
        type: 'trial_ending_soon',
        severity: 'warning',
        trialEndsAt: ctx.trialEndsAt,
        daysLeft: trialDays,
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

  const pendingChange = await buildPendingChange({
    sub,
    scheduledSub,
    renewalScheduledSamePlan,
  });

  let scheduledPlanOut = pendingChange?.type === 'plan_change_scheduled' ? pendingChange.planSku : null;
  let scheduledPlanNameOut = pendingChange?.type === 'plan_change_scheduled' ? pendingChange.planName : null;
  let scheduledDateOut =
    pendingChange?.type === 'plan_change_scheduled' || pendingChange?.type === 'renewal_scheduled'
      ? pendingChange.effectiveAt
      : null;
  if (renewalScheduledSamePlan && scheduledSub) {
    scheduledPlanOut = null;
    scheduledPlanNameOut = null;
    scheduledDateOut = scheduledSub.startDate?.toISOString() ?? null;
  }

  const billingView = sub ? subscriptionBillingView(sub) : null;

  const capabilities = await buildBillingCapabilities({
    organizationId,
    sub,
    scheduledSub,
    status,
    plan,
  });

  const entitlement = await buildEntitlementBlock(organizationId, sub, plan);

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
  const isManual = billingView?.isManual ?? false;
  const isAutomatic = billingView?.isAutomatic ?? false;

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
      isAutomatic,
      isManual,
      collectionMethodLabel: billingView?.collectionMethodLabel ?? null,
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
    paymentProvider: billingView?.paymentProvider ?? sub?.paymentProvider ?? null,
    billingStrategy: billingView?.billingStrategy ?? null,
    collectionMethodLabel: billingView?.collectionMethodLabel ?? null,
    legacyPaymentProviderId: billingView?.legacyPaymentProviderId ?? null,
    pendingChange,
    capabilities,
    entitlement,
    billing: billingView
      ? {
          strategy: billingView.billingStrategy,
          strategyLabel: billingView.collectionMethodLabel,
          paymentProvider: billingView.paymentProvider,
        }
      : null,
  };
}

module.exports = {
  getBillingOverview,
  priceWithIva,
  buildAlerts,
};
