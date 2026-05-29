'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const planService = require('../services/planService');
const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');
const { PAYMENT_PROVIDER_MP_CHECKOUT_PRO } = require('../lib/billingProviders');
const { createBillingCheckoutWithPendingChange } = require('../services/billingCheckoutService');
const logger = require('../lib/logger');

const CRON = process.env.PLAN_CHANGE_SCHEDULER_CRON || '15 */6 * * *';

/**
 * Cambios de plan programados en DB (manual_monthly): envía link de cobro sin mutar planId
 * hasta que el pago quede aprobado (webhook Checkout Pro).
 */
async function runPlanChangeScheduler() {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      status: 'active',
      isActiveSubscription: true,
      scheduledPlanId: { not: null },
      scheduledChangeAt: { lte: now },
      billingStrategy: BILLING_STRATEGY_MANUAL,
    },
    include: { plan: true, scheduledPlan: true, organization: { select: { ownerId: true, billingEmail: true } } },
  });

  for (const sub of due) {
    try {
      const newPlan = sub.scheduledPlan;
      if (!newPlan) continue;

      const existingPending = await prisma.checkoutSession.findFirst({
        where: {
          organizationId: sub.organizationId,
          status: 'pending',
          planId: newPlan.id,
          pendingChangeFromSubscriptionId: sub.id,
          expiresAt: { gt: now },
        },
      });
      if (existingPending?.checkoutUrl) {
        logger.info('[planChangeScheduler] Link pendiente ya existe', {
          organizationId: sub.organizationId,
          checkoutSessionId: existingPending.id,
        });
        continue;
      }

      const ownerId = sub.organization?.ownerId;
      if (!ownerId) continue;

      const restaurant = await prisma.restaurant.findFirst({
        where: { organizationId: sub.organizationId, isDeleted: false },
        select: { id: true },
      });
      if (!restaurant) continue;

      const payerEmail = sub.organization?.billingEmail || null;

      await createBillingCheckoutWithPendingChange({
        organizationId: sub.organizationId,
        userId: ownerId,
        payerEmail,
        planSKU: newPlan.productSKU,
        restaurantId: restaurant.id,
        when: 'now',
        paymentProvider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
        pendingChangeFromSubscriptionId: sub.id,
      });

      logger.info('[planChangeScheduler] Link de cobro generado (plan sin aplicar hasta pago)', {
        organizationId: sub.organizationId,
        planSKU: newPlan.productSKU,
      });
    } catch (err) {
      logger.error('[planChangeScheduler] Error generando link', {
        subscriptionId: sub.id,
        error: err?.message ?? err,
      });
    }
  }
}

function startPlanChangeSchedulerJob() {
  if (process.env.PLAN_CHANGE_SCHEDULER_ENABLED === 'false') return;
  cron.schedule(CRON, () => {
    runPlanChangeScheduler().catch((err) => {
      logger.error('[planChangeScheduler] Job falló', { error: err?.message ?? err });
    });
  });
  logger.info('[planChangeScheduler] Programado', { cron: CRON });
}

module.exports = { startPlanChangeSchedulerJob, runPlanChangeScheduler };
