'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./billingFlowMatrix');

const activeSub = { isActiveSubscription: true, status: 'active' };
const trialSub = { isActiveSubscription: true, status: 'trial' };
const graceSub = { isActiveSubscription: true, status: 'grace' };
const cancelledSub = { isActiveSubscription: true, status: 'cancelled' };
const expiredSub = { isActiveSubscription: false, status: 'expired' };
const adminCompedSub = { isActiveSubscription: true, status: 'cancelled_by_admin' };

describe('Activación (checkout vs reactivate)', () => {
  const cases = [
    ['trial', { subscriptionStatus: 'trial' }, 'checkout'],
    ['expired', { subscriptionStatus: 'expired' }, 'checkout'],
    ['active', { subscriptionStatus: 'active' }, 'not_activation'],
    ['cancelled', { subscriptionStatus: 'cancelled' }, 'reactivate_first'],
    ['grace', { subscriptionStatus: 'grace' }, 'recovery_first'],
  ];
  for (const [name, ctx, expectedPath] of cases) {
    test(`activation: ${name} → ${expectedPath}`, () => {
      assert.equal(resolveActivationFlow(ctx).path, expectedPath);
    });
  }
});

describe('Elegibilidad cambio de plan', () => {
  test('activo + self-service → allowed', () => {
    const r = resolveChangePlanEligibility({ sub: activeSub, selfServicePlanChanges: true });
    assert.equal(r.allowed, true);
    assert.equal(r.suggestedFlow, 'change_plan');
  });

  test('trial → checkout (no change-plan)', () => {
    const r = resolveChangePlanEligibility({ sub: trialSub, selfServicePlanChanges: true });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'trial_checkout_required');
    assert.equal(r.suggestedFlow, 'checkout');
  });

  test('grace → blocked', () => {
    const r = resolveChangePlanEligibility({ sub: graceSub });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'grace');
  });

  test('cancelled in-period → reactivate', () => {
    const r = resolveChangePlanEligibility({ sub: cancelledSub });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'cancelled_in_period');
    assert.equal(r.suggestedFlow, 'reactivate');
  });

  test('sin sub → no_subscription', () => {
    const r = resolveChangePlanEligibility({ sub: null });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'no_subscription');
  });

  test('enterprise plan_changes_managed', () => {
    const r = resolveChangePlanEligibility({ sub: activeSub, selfServicePlanChanges: false });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'plan_changes_managed');
  });

  test('custom/default: misma regla si sub activa (orgCanUsePlan es capa aparte)', () => {
    const r = resolveChangePlanEligibility({ sub: activeSub });
    assert.equal(r.allowed, true);
  });
});

describe('Ejecución cambio de plan (activo)', () => {
  const matrix = [
    ['manual + EOP', BILLING_STRATEGY_MANUAL, PLAN_CHANGE_END_OF_PERIOD, 'schedule_db', false],
    ['manual + immediate', BILLING_STRATEGY_MANUAL, PLAN_CHANGE_IMMEDIATE, 'mp_checkout', true],
    ['auto + EOP', BILLING_STRATEGY_AUTOMATIC, PLAN_CHANGE_END_OF_PERIOD, 'mp_checkout', true],
    ['auto + immediate', BILLING_STRATEGY_AUTOMATIC, PLAN_CHANGE_IMMEDIATE, 'mp_checkout', true],
  ];
  for (const [label, strategy, when, path, requiresCheckout] of matrix) {
    test(`plan change execution: ${label}`, () => {
      const r = resolvePlanChangeExecutionPath({ billingStrategy: strategy, when });
      assert.equal(r.path, path);
      assert.equal(r.requiresCheckout, requiresCheckout);
      if (path === 'schedule_db') assert.equal(r.scheduled, true);
    });
  }
});

describe('Preview flags cambio de plan', () => {
  test('manual EOP → schedulesInDbOnly, sin checkout', () => {
    const f = resolvePlanChangePreviewFlags({
      billingStrategy: BILLING_STRATEGY_MANUAL,
      when: PLAN_CHANGE_END_OF_PERIOD,
    });
    assert.equal(f.schedulesInDbOnly, true);
    assert.equal(f.requiresCheckout, false);
    assert.equal(f.requiresCheckoutForWhen.end_of_period, false);
  });

  test('auto EOP → requiere checkout', () => {
    const f = resolvePlanChangePreviewFlags({
      billingStrategy: BILLING_STRATEGY_AUTOMATIC,
      when: PLAN_CHANGE_END_OF_PERIOD,
    });
    assert.equal(f.requiresCheckoutForWhen.end_of_period, true);
  });

  test('cualquier immediate → checkout', () => {
    for (const strategy of [BILLING_STRATEGY_MANUAL, BILLING_STRATEGY_AUTOMATIC]) {
      const f = resolvePlanChangePreviewFlags({ billingStrategy: strategy, when: PLAN_CHANGE_IMMEDIATE });
      assert.equal(f.requiresCheckout, true);
    }
  });
});

describe('Método de cobro — elegibilidad', () => {
  test('activo → allowed', () => {
    const r = resolvePaymentMethodUpdateEligibility({
      sub: activeSub,
      selfServiceBillingStrategyChanges: true,
    });
    assert.equal(r.allowed, true);
  });

  test('trial → preference_until_checkout', () => {
    const r = resolvePaymentMethodUpdateEligibility({ sub: trialSub });
    assert.equal(r.allowed, false);
    assert.equal(r.suggestedFlow, 'preference_until_checkout');
  });

  test('expired → activate_first', () => {
    const r = resolvePaymentMethodUpdateEligibility({ sub: expiredSub });
    assert.equal(r.allowed, false);
  });

  test('cancelado → blocked', () => {
    const r = resolvePaymentMethodUpdateEligibility({ sub: cancelledSub });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'cancelled_in_period');
  });

  test('grace → blocked', () => {
    const r = resolvePaymentMethodUpdateEligibility({ sub: graceSub });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'grace');
  });

  test('strategy managed by support', () => {
    const r = resolvePaymentMethodUpdateEligibility({
      sub: activeSub,
      selfServiceBillingStrategyChanges: false,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'billing_strategy_managed');
  });
});

describe('Método de cobro — ejecución (subs ↔ checkout)', () => {
  test('subs → checkout (auto → manual): in_place', () => {
    const r = resolvePaymentMethodExecutionPath({
      currentStrategy: BILLING_STRATEGY_AUTOMATIC,
      targetStrategy: BILLING_STRATEGY_MANUAL,
    });
    assert.equal(r.path, 'in_place');
    assert.equal(r.updatedInPlace, true);
  });

  test('checkout → subs (manual → auto): mp_checkout', () => {
    const r = resolvePaymentMethodExecutionPath({
      currentStrategy: BILLING_STRATEGY_MANUAL,
      targetStrategy: BILLING_STRATEGY_AUTOMATIC,
    });
    assert.equal(r.path, 'mp_checkout');
    assert.equal(r.requiresCheckout, true);
  });

  test('mismo método: noop', () => {
    const r = resolvePaymentMethodExecutionPath({
      currentStrategy: BILLING_STRATEGY_MANUAL,
      targetStrategy: BILLING_STRATEGY_MANUAL,
    });
    assert.equal(r.path, 'noop');
  });
});

describe('Reactivación (cancelado con acceso)', () => {
  test('manual + EOP → in_place', () => {
    const r = resolveReactivateExecutionPath({
      billingStrategy: BILLING_STRATEGY_MANUAL,
      when: 'end_of_period',
    });
    assert.equal(r.path, 'in_place');
    assert.equal(r.requiresCheckout, false);
  });

  test('auto + EOP → mp checkout programado', () => {
    const r = resolveReactivateExecutionPath({
      billingStrategy: BILLING_STRATEGY_AUTOMATIC,
      when: 'end_of_period',
    });
    assert.equal(r.path, 'mp_checkout');
    assert.equal(r.mpWhen, 'end_of_period');
  });

  test('manual + now → mp checkout', () => {
    const r = resolveReactivateExecutionPath({
      billingStrategy: BILLING_STRATEGY_MANUAL,
      when: 'now',
    });
    assert.equal(r.path, 'mp_checkout');
    assert.equal(r.mpWhen, 'now');
  });

  test('auto + now → mp checkout', () => {
    const r = resolveReactivateExecutionPath({
      billingStrategy: BILLING_STRATEGY_AUTOMATIC,
      when: 'immediate',
    });
    assert.equal(r.path, 'mp_checkout');
  });
});

describe('Cancelar programado', () => {
  test('cambio DB (manual EOP)', () => {
    const r = resolveCancelScheduledTarget({
      scheduledPlanId: 'plan-1',
      scheduledChangeAt: new Date(),
      hasMpScheduledSub: false,
    });
    assert.equal(r.kind, 'db_plan_change');
  });

  test('solo MP scheduled', () => {
    const r = resolveCancelScheduledTarget({
      scheduledPlanId: null,
      scheduledChangeAt: null,
      hasMpScheduledSub: true,
    });
    assert.equal(r.kind, 'mp_scheduled');
  });

  test('DB tiene prioridad si ambos', () => {
    const r = resolveCancelScheduledTarget({
      scheduledPlanId: 'plan-1',
      scheduledChangeAt: new Date(),
      hasMpScheduledSub: true,
    });
    assert.equal(r.kind, 'db_plan_change');
  });

  test('nada programado', () => {
    const r = resolveCancelScheduledTarget({});
    assert.equal(r.kind, null);
    assert.equal(r.error, 'no_scheduled_change');
  });
});

describe('Capabilities UI vs API', () => {
  test('trial: canChangePlan true en capabilities pero change-plan bloqueado en API', () => {
    const gate = { allowed: true };
    const caps = resolveCapabilitiesFlags({ gate, uiStatus: 'trial' });
    assert.equal(caps.canChangePlan, true);
    assert.equal(caps.canChangeStrategy, false);
    const api = resolveChangePlanEligibility({ sub: trialSub });
    assert.equal(api.allowed, false);
  });

  test('active: plan y strategy', () => {
    const gate = { allowed: true };
    const caps = resolveCapabilitiesFlags({ gate, uiStatus: 'active' });
    assert.equal(caps.canChangePlan, true);
    assert.equal(caps.canChangeStrategy, true);
  });

  test('admin comped: todo false', () => {
    const gate = { allowed: false };
    const caps = resolveCapabilitiesFlags({ gate, uiStatus: 'active', isAdminComped: true });
    assert.equal(caps.canChangePlan, false);
    assert.equal(caps.canChangeStrategy, false);
  });
});

describe('Escenarios explícitos del producto', () => {
  test('plan custom: activación vía checkout (trial)', () => {
    assert.equal(resolveActivationFlow({ subscriptionStatus: 'trial' }).path, 'checkout');
    assert.equal(resolveChangePlanEligibility({ sub: trialSub }).suggestedFlow, 'checkout');
  });

  test('cambio de plan custom ↔ default con sub activa', () => {
    assert.equal(resolveChangePlanEligibility({ sub: activeSub }).allowed, true);
    assert.equal(
      resolvePlanChangeExecutionPath({
        billingStrategy: BILLING_STRATEGY_MANUAL,
        when: PLAN_CHANGE_END_OF_PERIOD,
      }).path,
      'schedule_db',
    );
  });

  test('subs → checkout con plan activo', () => {
    assert.equal(
      resolvePaymentMethodUpdateEligibility({ sub: activeSub }).allowed,
      true,
    );
    assert.equal(
      resolvePaymentMethodExecutionPath({
        currentStrategy: BILLING_STRATEGY_AUTOMATIC,
        targetStrategy: BILLING_STRATEGY_MANUAL,
      }).path,
      'in_place',
    );
  });

  test('subs → checkout con trial (solo preferencia, no API update)', () => {
    assert.equal(
      resolvePaymentMethodUpdateEligibility({ sub: trialSub }).suggestedFlow,
      'preference_until_checkout',
    );
  });

  test('subs → checkout con plan expirado', () => {
    assert.equal(
      resolvePaymentMethodUpdateEligibility({ sub: expiredSub }).allowed,
      false,
    );
    assert.equal(resolveActivationFlow({ subscriptionStatus: 'expired' }).path, 'checkout');
  });

  test('subs → checkout con plan cancelado', () => {
    assert.equal(resolvePaymentMethodUpdateEligibility({ sub: cancelledSub }).code, 'cancelled_in_period');
    assert.equal(resolveActivationFlow({ subscriptionStatus: 'cancelled' }).path, 'reactivate_first');
  });

  test('checkout → subs con plan activo', () => {
    assert.equal(
      resolvePaymentMethodExecutionPath({
        currentStrategy: BILLING_STRATEGY_MANUAL,
        targetStrategy: BILLING_STRATEGY_AUTOMATIC,
      }).path,
      'mp_checkout',
    );
  });

  test('checkout → subs con trial (al activar en checkout)', () => {
    assert.equal(resolveActivationFlow({ subscriptionStatus: 'trial' }).endpoint, 'POST /billing/checkout');
  });

  test('checkout → subs con plan expirado', () => {
    assert.equal(resolveActivationFlow({ subscriptionStatus: 'expired' }).path, 'checkout');
  });

  test('checkout → subs con plan cancelado', () => {
    assert.equal(
      resolveReactivateExecutionPath({
        billingStrategy: BILLING_STRATEGY_MANUAL,
        when: 'now',
      }).path,
      'mp_checkout',
    );
  });
});

describe('Matriz combinada usuario (smoke)', () => {
  const scenarios = [
    {
      id: 'custom_activate_trial_checkout',
      activation: { subscriptionStatus: 'trial' },
      planChange: { sub: trialSub },
      expectActivation: 'checkout',
      expectPlanAllowed: false,
    },
    {
      id: 'default_to_custom_active_eop_manual',
      planExec: { billingStrategy: BILLING_STRATEGY_MANUAL, when: PLAN_CHANGE_END_OF_PERIOD },
      expectPlanPath: 'schedule_db',
    },
    {
      id: 'custom_to_default_active_immediate',
      planExec: { billingStrategy: BILLING_STRATEGY_MANUAL, when: PLAN_CHANGE_IMMEDIATE },
      expectPlanPath: 'mp_checkout',
    },
    {
      id: 'active_subs_to_checkout',
      methodExec: { currentStrategy: BILLING_STRATEGY_AUTOMATIC, targetStrategy: BILLING_STRATEGY_MANUAL },
      expectMethodPath: 'in_place',
    },
    {
      id: 'active_checkout_to_subs',
      methodExec: { currentStrategy: BILLING_STRATEGY_MANUAL, targetStrategy: BILLING_STRATEGY_AUTOMATIC },
      expectMethodPath: 'mp_checkout',
    },
    {
      id: 'cancelled_reactivate_manual_eop',
      reactivate: { billingStrategy: BILLING_STRATEGY_MANUAL, when: 'end_of_period' },
      expectReactivatePath: 'in_place',
    },
    {
      id: 'expired_activate_checkout',
      activation: { subscriptionStatus: 'expired' },
      expectActivation: 'checkout',
    },
  ];

  for (const s of scenarios) {
    test(`smoke: ${s.id}`, () => {
      if (s.activation) {
        assert.equal(resolveActivationFlow(s.activation).path, s.expectActivation);
      }
      if (s.planChange) {
        assert.equal(resolveChangePlanEligibility(s.planChange).allowed, s.expectPlanAllowed);
      }
      if (s.planExec) {
        assert.equal(resolvePlanChangeExecutionPath(s.planExec).path, s.expectPlanPath);
      }
      if (s.methodExec) {
        assert.equal(resolvePaymentMethodExecutionPath(s.methodExec).path, s.expectMethodPath);
      }
      if (s.reactivate) {
        assert.equal(resolveReactivateExecutionPath(s.reactivate).path, s.expectReactivatePath);
      }
    });
  }
});
