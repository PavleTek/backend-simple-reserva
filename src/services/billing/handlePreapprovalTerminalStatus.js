'use strict';

const prisma = require('../../lib/prisma');
const planService = require('../planService');

/**
 * Decide acción ante preapproval MP cancelled/expired (lógica pura para tests).
 * @param {{ hasOtherActiveEntitlement: boolean, linkedStatus: string|null, stillInPeriod: boolean }} ctx
 */
function decidePreapprovalTerminalAction(ctx) {
  const { hasOtherActiveEntitlement, linkedStatus, stillInPeriod } = ctx;
  if (hasOtherActiveEntitlement) return 'ignore_replacement';
  if (!linkedStatus) return 'no_linked';
  if (linkedStatus === 'scheduled') return 'cancel_scheduled';
  if (linkedStatus === 'active' && stillInPeriod) return 'cancel_at_period_end';
  if (linkedStatus === 'active' || linkedStatus === 'grace') return 'expire';
  if (linkedStatus === 'cancelled' || linkedStatus === 'expired') return 'already_terminal';
  return 'no_op';
}

/**
 * MP preapproval cancelled/expired — NO usar enterGracePeriod (solo payment_required).
 * @param {string} organizationId
 * @param {string} preapprovalId
 * @param {'cancelled'|'expired'} mpStatus
 */
async function handlePreapprovalCancelledOrExpired(organizationId, preapprovalId, mpStatus) {
  const activeOther = await prisma.subscription.findFirst({
    where: {
      organizationId,
      isActiveSubscription: true,
      NOT: { mercadopagoPreapprovalId: preapprovalId },
    },
    select: { id: true },
  });

  const linked = await prisma.subscription.findFirst({
    where: { organizationId, mercadopagoPreapprovalId: preapprovalId },
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
        mercadopagoPreapprovalId: preapprovalId,
        status: { in: ['scheduled', 'active', 'grace'] },
      },
      data: {
        status: 'cancelled',
        isActiveSubscription: false,
        mercadopagoPreapprovalId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, mpStatus };
  }

  if (action === 'no_linked' || action === 'already_terminal' || action === 'no_op') {
    return { action, mpStatus };
  }

  if (action === 'cancel_scheduled' && linked) {
    await prisma.subscription.update({
      where: { id: linked.id },
      data: {
        status: 'cancelled',
        isActiveSubscription: false,
        mercadopagoPreapprovalId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, mpStatus };
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
        mercadopagoPreapprovalId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, mpStatus };
  }

  if (action === 'expire' && linked) {
    await prisma.subscription.update({
      where: { id: linked.id },
      data: {
        status: 'expired',
        isActiveSubscription: false,
        endDate: new Date(),
        mercadopagoPreapprovalId: null,
      },
    });
    planService.invalidateCache(organizationId);
    return { action, mpStatus };
  }

  return { action, mpStatus };
}

module.exports = {
  decidePreapprovalTerminalAction,
  handlePreapprovalCancelledOrExpired,
};
