'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const { decidePreapprovalTerminalAction } = require('./handlePreapprovalTerminalStatus');

/**
 * Flow subscription cancelled/deleted. Payment failures use enterGracePeriod;
 * this handler is only for a remote subscription that is no longer active.
 *
 * @param {string} organizationId
 * @param {string} flowSubscriptionId
 * @param {string} flowStatus
 */
async function handleFlowSubscriptionCancelled(organizationId, flowSubscriptionId, flowStatus) {
  const activeOther = await prisma.subscription.findFirst({
    where: {
      organizationId,
      isActiveSubscription: true,
      NOT: { flowSubscriptionId },
    },
    select: { id: true },
  });

  const linked = await prisma.subscription.findFirst({
    where: { organizationId, flowSubscriptionId },
    orderBy: { startDate: 'desc' },
  });

  const periodEnd = linked?.currentPeriodEnd || linked?.endDate;
  const stillInPeriod =
    !!periodEnd && !Number.isNaN(new Date(periodEnd).getTime()) && new Date() < new Date(periodEnd);

  const action = decidePreapprovalTerminalAction({
    hasOtherActiveEntitlement: !!activeOther,
    linkedStatus: linked?.status ?? null,
    stillInPeriod,
  });

  if (action === 'ignore_replacement' && linked) {
    await prisma.subscription.updateMany({
      where: {
        organizationId,
        flowSubscriptionId,
        status: { in: ['scheduled', 'active', 'grace'] },
      },
      data: {
        status: 'cancelled',
        isActiveSubscription: false,
        flowSubscriptionId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, flowStatus };
  }

  if (action === 'no_linked' || action === 'already_terminal' || action === 'no_op') {
    return { action, flowStatus };
  }

  if (action === 'cancel_scheduled' && linked) {
    await prisma.subscription.update({
      where: { id: linked.id },
      data: {
        status: 'cancelled',
        isActiveSubscription: false,
        flowSubscriptionId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, flowStatus };
  }

  if (action === 'cancel_at_period_end' && linked) {
    const end = linked.currentPeriodEnd || linked.endDate || new Date();
    await prisma.subscription.update({
      where: { id: linked.id },
      data: {
        status: 'cancelled',
        endDate: end,
        currentPeriodEnd: end,
        gracePeriodEndsAt: end,
        isActiveSubscription: true,
        flowSubscriptionId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, flowStatus };
  }

  if (action === 'expire' && linked) {
    await prisma.subscription.update({
      where: { id: linked.id },
      data: {
        status: 'expired',
        isActiveSubscription: false,
        endDate: new Date(),
        flowSubscriptionId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, flowStatus };
  }

  return { action, flowStatus };
}

module.exports = { handleFlowSubscriptionCancelled };
