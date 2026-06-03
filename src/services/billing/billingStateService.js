'use strict';

/**
 * Punto único para efectos de transición de billing (webhooks, jobs, rutas).
 * La máquina de estados en subscriptionStateMachine.js delega aquí.
 */

const prisma = require('../../lib/prisma');
const planService = require('../planService');
const {
  enterGracePeriod,
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
} = require('../mercadopagoService');
const { handlePreapprovalCancelledOrExpired } = require('./handlePreapprovalTerminalStatus');
const { transition } = require('./subscriptionStateMachine');

const EVENT_HANDLERS = {
  PAYMENT_FAILED: async (organizationId, payload) => {
    await enterGracePeriod(organizationId, {
      scheduledPreapprovalId: payload?.preapprovalId ?? null,
    });
    return { ok: true };
  },
  PAYMENT_RECOVERED: async (organizationId) => {
    await prisma.subscription.updateMany({
      where: { organizationId, status: 'grace' },
      data: { status: 'active', gracePeriodEndsAt: null, isActiveSubscription: true },
    });
    planService.invalidateCache(organizationId);
    return { ok: true };
  },
  MP_PREAPPROVAL_CANCELLED: async (organizationId, payload) => {
    return handlePreapprovalCancelledOrExpired(
      organizationId,
      payload.preapprovalId,
      payload.mpStatus || 'cancelled',
    );
  },
  CHECKOUT_APPROVED: async (organizationId, payload) => {
    await activateOrganizationSubscription(
      organizationId,
      payload.preapprovalId ?? null,
      payload.planSKU,
      payload.activateOptions ?? {},
    );
    return { ok: true };
  },
  PLAN_CHANGE_SCHEDULED_MP: async (organizationId, payload) => {
    await scheduleOrganizationSubscription(
      organizationId,
      payload.preapprovalId,
      payload.planSKU,
      new Date(payload.startDate),
    );
    return { ok: true };
  },
};

/**
 * @param {string} organizationId
 * @param {string} event — PAYMENT_FAILED | PAYMENT_RECOVERED | MP_PREAPPROVAL_CANCELLED | ...
 * @param {object} [payload]
 * @param {{ currentStatus?: string, logOnly?: boolean }} [opts]
 */
async function applyBillingEvent(organizationId, event, payload = {}, opts = {}) {
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true },
    orderBy: { startDate: 'desc' },
    select: { status: true },
  });
  const currentStatus = opts.currentStatus || sub?.status || 'expired';
  const { newStatus, sideEffects } = transition(currentStatus, event, { logOnly: true });

  const handler = EVENT_HANDLERS[event];
  let result = { newStatus, sideEffects, handled: false };
  if (handler) {
    result = { ...(await handler(organizationId, payload)), newStatus, sideEffects, handled: true };
  }

  return result;
}

module.exports = {
  applyBillingEvent,
  EVENT_HANDLERS,
};
