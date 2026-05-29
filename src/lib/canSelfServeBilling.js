'use strict';

/**
 * ¿Puede el dueño iniciar checkout, cambio de plan o método de cobro desde el portal?
 * Acceso a producto = isActiveSubscription; esto es solo operaciones de billing self-service.
 *
 * @param {object|null|undefined} sub — fila Subscription
 * @returns {{ allowed: boolean, reason?: string, code?: string }}
 */
function canSelfServeBilling(sub) {
  if (!sub) {
    return { allowed: false, reason: 'No tienes una suscripción activa.', code: 'no_subscription' };
  }
  if (!sub.isActiveSubscription) {
    return {
      allowed: false,
      reason: 'No tienes acceso activo. Elige un plan para reactivar.',
      code: 'no_access',
    };
  }
  if (sub.status === 'cancelled_by_admin') {
    return {
      allowed: false,
      reason: 'Tu plan está gestionado por SimpleReserva. Contacta a soporte.',
      code: 'admin_comped',
    };
  }
  if (sub.status === 'grace') {
    return {
      allowed: false,
      reason: 'Regulariza el cobro pendiente antes de hacer otros cambios.',
      code: 'grace',
    };
  }
  if (sub.status === 'cancelled') {
    return {
      allowed: false,
      reason: 'Reactiva tu suscripción antes de cambiar plan o método de cobro.',
      code: 'cancelled_in_period',
    };
  }
  if (sub.status === 'trial') {
    return { allowed: true, code: 'trial' };
  }
  if (sub.status === 'active') {
    return { allowed: true, code: 'active' };
  }
  return {
    allowed: false,
    reason: 'Solo puedes gestionar facturación con una suscripción activa.',
    code: 'status_blocked',
  };
}

/**
 * @param {object|null|undefined} sub
 */
function canSelfServeBillingOrThrow(sub) {
  const gate = canSelfServeBilling(sub);
  if (!gate.allowed) {
    const err = new Error(gate.reason);
    err.statusCode = 400;
    err.code = gate.code;
    throw err;
  }
  return gate;
}

module.exports = {
  canSelfServeBilling,
  canSelfServeBillingOrThrow,
};
