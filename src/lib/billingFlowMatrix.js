'use strict';

const { canSelfServeBilling } = require('./canSelfServeBilling');
const {
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
  normalizePlanChangeWhen,
} = require('./billingDomain');

/** @typedef {'activate_checkout'|'change_plan'|'reactivate'|'payment_method_update'|'cancel_scheduled'|'recovery'} BillingUserAction */

/**
 * Flujo de activación inicial (trial / expirado sin plan de pago).
 * @param {{ subscriptionStatus?: string|null, hasActivePaidPlan?: boolean }} ctx
 */
function resolveActivationFlow(ctx) {
  const status = ctx.subscriptionStatus ?? null;
  if (status === 'active') {
    return { path: 'not_activation', reason: 'already_active' };
  }
  if (status === 'trial') {
    return { path: 'checkout', endpoint: 'POST /billing/checkout', when: 'now' };
  }
  if (status === 'cancelled') {
    return { path: 'reactivate_first', endpoint: 'POST /billing/reactivate' };
  }
  if (status === 'grace') {
    return { path: 'recovery_first', endpoint: 'recovery' };
  }
  return { path: 'checkout', endpoint: 'POST /billing/checkout', when: 'now' };
}

/**
 * ¿Puede usar change-plan/preview? (reglas de API, no solo capabilities UI).
 * @param {{ sub: object|null, selfServicePlanChanges?: boolean }} ctx
 */
function resolveChangePlanEligibility(ctx) {
  const { sub } = ctx;
  const selfServicePlanChanges = ctx.selfServicePlanChanges !== false;
  const gate = canSelfServeBilling(sub);

  if (!gate.allowed) {
    return { allowed: false, code: gate.code, suggestedFlow: gate.code === 'cancelled_in_period' ? 'reactivate' : 'blocked' };
  }
  if (!selfServicePlanChanges) {
    return { allowed: false, code: 'plan_changes_managed', suggestedFlow: 'contact_support' };
  }
  if (!sub || sub.status !== 'active') {
    return {
      allowed: false,
      code: 'trial_checkout_required',
      suggestedFlow: sub?.status === 'trial' ? 'checkout' : 'checkout_or_reactivate',
    };
  }
  return { allowed: true, code: 'active', suggestedFlow: 'change_plan' };
}

/**
 * Ruta de ejecución tras confirmar cambio de plan (sub activa).
 * @param {{ billingStrategy: string, when: string }} ctx
 */
function resolvePlanChangeExecutionPath(ctx) {
  const when = normalizePlanChangeWhen(ctx.when);
  const strategy = ctx.billingStrategy;

  if (when === PLAN_CHANGE_END_OF_PERIOD && strategy === BILLING_STRATEGY_MANUAL) {
    return {
      path: 'schedule_db',
      endpoint: 'POST /billing/change-plan',
      scheduled: true,
      requiresCheckout: false,
      schedulesInDbOnly: true,
    };
  }
  if (when === PLAN_CHANGE_IMMEDIATE) {
    return {
      path: 'mp_checkout',
      endpoint: 'POST /billing/change-plan',
      scheduled: false,
      requiresCheckout: true,
      mpWhen: 'now',
    };
  }
  return {
    path: 'mp_checkout',
    endpoint: 'POST /billing/change-plan',
    scheduled: false,
    requiresCheckout: true,
    mpWhen: 'end_of_period',
  };
}

/**
 * Flags de preview (espejo de changePlanPreviewService).
 * @param {{ billingStrategy: string, when: string }} ctx
 */
function resolvePlanChangePreviewFlags(ctx) {
  const when = normalizePlanChangeWhen(ctx.when);
  const strategy = ctx.billingStrategy;
  return {
    requiresCheckout:
      when === PLAN_CHANGE_IMMEDIATE ||
      (when === PLAN_CHANGE_END_OF_PERIOD && strategy === BILLING_STRATEGY_AUTOMATIC),
    requiresCheckoutForWhen: {
      immediate: true,
      end_of_period: strategy === BILLING_STRATEGY_AUTOMATIC,
    },
    schedulesInDbOnly:
      when === PLAN_CHANGE_END_OF_PERIOD && strategy === BILLING_STRATEGY_MANUAL,
  };
}

/**
 * @param {{ sub: object|null, selfServiceBillingStrategyChanges?: boolean, uiStatus?: string }} ctx
 */
function resolvePaymentMethodUpdateEligibility(ctx) {
  const { sub } = ctx;
  const selfServiceBillingStrategyChanges = ctx.selfServiceBillingStrategyChanges !== false;
  const gate = canSelfServeBilling(sub);

  if (!gate.allowed) {
    return { allowed: false, code: gate.code, suggestedFlow: 'blocked' };
  }
  if (!selfServiceBillingStrategyChanges) {
    return { allowed: false, code: 'billing_strategy_managed', suggestedFlow: 'contact_support' };
  }
  if (!sub || sub.status !== 'active') {
    return {
      allowed: false,
      code: 'active_plan_required',
      suggestedFlow: sub?.status === 'trial' ? 'preference_until_checkout' : 'activate_first',
    };
  }
  return { allowed: true, code: 'active', suggestedFlow: 'payment_method_update' };
}

/**
 * @param {{ currentStrategy: string, targetStrategy: string }} ctx
 */
function resolvePaymentMethodExecutionPath(ctx) {
  const { resolveCollectionMethodChange } = require('../services/billing/collectionMethodSwitchService');
  const change = resolveCollectionMethodChange(
    { billingStrategy: ctx.currentStrategy },
    ctx.targetStrategy,
  );
  if (change.kind === 'noop') {
    return { path: 'noop', requiresCheckout: false, updatedInPlace: false };
  }
  if (change.kind === 'automatic_to_manual') {
    return {
      path: 'in_place',
      endpoint: 'POST /billing/payment-method/update',
      requiresCheckout: false,
      updatedInPlace: true,
    };
  }
  return {
    path: 'mp_checkout',
    endpoint: 'POST /billing/payment-method/update',
    requiresCheckout: true,
    updatedInPlace: false,
  };
}

/**
 * Reactivación (cancelled con acceso).
 * @param {{ billingStrategy: string, when: string }} ctx
 */
function resolveReactivateExecutionPath(ctx) {
  const when = ctx.when === 'now' || ctx.when === 'immediate' ? 'now' : 'end_of_period';
  const strategy = ctx.billingStrategy;

  if (when === 'end_of_period' && strategy === BILLING_STRATEGY_MANUAL) {
    return {
      path: 'in_place',
      endpoint: 'POST /billing/reactivate',
      requiresCheckout: false,
      reactivated: true,
    };
  }
  return {
    path: 'mp_checkout',
    endpoint: 'POST /billing/reactivate',
    requiresCheckout: true,
    mpWhen: when,
  };
}

/**
 * Qué cancela cancel-scheduled.
 * @param {{ scheduledPlanId?: string|null, scheduledChangeAt?: Date|string|null, hasMpScheduledSub?: boolean }} ctx
 */
function resolveCancelScheduledTarget(ctx) {
  if (ctx.scheduledPlanId && ctx.scheduledChangeAt) {
    return { kind: 'db_plan_change', endpoint: 'POST /billing/cancel-scheduled' };
  }
  if (ctx.hasMpScheduledSub) {
    return { kind: 'mp_scheduled', endpoint: 'POST /billing/cancel-scheduled' };
  }
  return { kind: null, error: 'no_scheduled_change' };
}

/**
 * Capabilities expuestas al front (espejo de buildBillingCapabilities sin async).
 * @param {{ gate: { allowed: boolean }, selfServicePlanChanges?: boolean, selfServiceBillingStrategyChanges?: boolean, uiStatus: string, isAdminComped?: boolean }} ctx
 */
function resolveCapabilitiesFlags(ctx) {
  const plan = ctx.selfServicePlanChanges !== false;
  const strategy = ctx.selfServiceBillingStrategyChanges !== false;
  const gateOk = ctx.gate?.allowed === true;
  const comped = ctx.isAdminComped === true;
  return {
    canChangePlan: gateOk && plan && !comped,
    canChangeStrategy: gateOk && strategy && !comped && ctx.uiStatus === 'active',
  };
}

module.exports = {
  resolveActivationFlow,
  resolveChangePlanEligibility,
  resolvePlanChangeExecutionPath,
  resolvePlanChangePreviewFlags,
  resolvePaymentMethodUpdateEligibility,
  resolvePaymentMethodExecutionPath,
  resolveReactivateExecutionPath,
  resolveCancelScheduledTarget,
  resolveCapabilitiesFlags,
  BILLING_STRATEGY_AUTOMATIC,
  BILLING_STRATEGY_MANUAL,
  PLAN_CHANGE_IMMEDIATE,
  PLAN_CHANGE_END_OF_PERIOD,
};
