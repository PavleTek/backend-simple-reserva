'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const planService = require('../services/planService');
const { computePeriodEnd } = require('../lib/billingPeriod');
const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');
const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');
const logger = require('../lib/logger');

const CRON = process.env.PLAN_CHANGE_SCHEDULER_CRON || '15 */6 * * *';

/**
 * Aplica cambios de plan programados en DB (manual_monthly) al vencer scheduledChangeAt.
 */
async function runPlanChangeScheduler() {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      status: 'active',
      isActiveSubscription: true,
      scheduledPlanId: { not: null },
      scheduledChangeAt: { lte: now },
    },
    include: { plan: true, scheduledPlan: true, organization: { select: { ownerId: true } } },
  });

  for (const sub of due) {
    try {
      const newPlan = sub.scheduledPlan;
      if (!newPlan) continue;

      const activatedAt = new Date();
      const nextPeriodEnd = computePeriodEnd(activatedAt, newPlan);

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          planId: newPlan.id,
          scheduledPlanId: null,
          scheduledChangeAt: null,
          planChangeWhen: null,
          currentPeriodEnd: nextPeriodEnd,
        },
      });

      await prisma.restaurantOrganization.update({
        where: { id: sub.organizationId },
        data: { planId: newPlan.id },
      });

      planService.invalidateCache(sub.organizationId);

      if (sub.billingStrategy === BILLING_STRATEGY_MANUAL) {
        const ownerId = sub.organization?.ownerId;
        if (ownerId) {
          const restaurant = await prisma.restaurant.findFirst({
            where: { organizationId: sub.organizationId, isDeleted: false },
            select: { id: true },
          });
          if (restaurant) {
            try {
              await mercadopagoCheckoutProService.createCheckoutPreference({
                organizationId: sub.organizationId,
                userId: ownerId,
                payerEmail: null,
                planSKU: newPlan.productSKU,
                restaurantId: restaurant.id,
                checkoutSessionId: `plan-change-${sub.id}-${Date.now()}`,
              });
            } catch (linkErr) {
              logger.warn('[planChangeScheduler] No se pudo generar link de cobro', {
                organizationId: sub.organizationId,
                error: linkErr?.message,
              });
            }
          }
        }
      }

      logger.info('[planChangeScheduler] Plan aplicado', {
        organizationId: sub.organizationId,
        planSKU: newPlan.productSKU,
      });
    } catch (err) {
      logger.error('[planChangeScheduler] Error aplicando cambio', {
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
