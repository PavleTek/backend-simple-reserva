/**
 * Dispatcher de checkout de facturación (fase 1: MP Preapproval + Checkout Pro).
 */

const prisma = require('../lib/prisma');
const mercadopagoService = require('./mercadopagoService');
const mercadopagoCheckoutProService = require('./mercadopagoCheckoutProService');
const {
  PAYMENT_PROVIDER_MP_PREAPPROVAL,
  PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
  normalizePaymentProvider,
  isProviderEnabled,
} = require('../lib/billingProviders');

function checkoutProSupportsWhen(when) {
  return when === 'now';
}

/**
 * @returns {{ checkoutUrl, providerId, mercadopagoPreapprovalId?, mercadopagoPreferenceId?, checkoutHints }}
 */
async function createBillingCheckout({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  when,
  paymentProvider: rawProvider,
  createSubscriptionOptions = {},
}) {
  const paymentProvider = normalizePaymentProvider(rawProvider);
  if (!isProviderEnabled(paymentProvider)) {
    const err = new Error('Método de pago no disponible.');
    err.statusCode = 400;
    throw err;
  }

  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO && !checkoutProSupportsWhen(when)) {
    const err = new Error(
      'El pago con tarjeta (Checkout Pro) solo permite activación inmediata. Para programar al fin de la prueba, usa débito automático Mercado Pago.',
    );
    err.statusCode = 400;
    throw err;
  }

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) {
    const err = new Error('Plan no encontrado.');
    err.statusCode = 400;
    throw err;
  }

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      organizationId,
      userId,
      planId: plan.id,
      status: 'pending',
      expiresAt,
      paymentProvider,
    },
  });

  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO) {
    const result = await mercadopagoCheckoutProService.createCheckoutPreference({
      organizationId,
      userId,
      payerEmail,
      planSKU,
      restaurantId,
      checkoutSessionId: checkoutSession.id,
    });

    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: {
        mercadopagoPreferenceId: result.id,
        checkoutUrl: result.init_point,
      },
    });

    return {
      checkoutUrl: result.init_point,
      providerId: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      mercadopagoPreferenceId: result.id,
      checkoutHints: mercadopagoCheckoutProService.getCheckoutProHints(),
    };
  }

  const result = await mercadopagoService.createSubscription(
    organizationId,
    userId,
    payerEmail,
    planSKU,
    restaurantId,
    createSubscriptionOptions,
  );

  const checkoutUrl = result?.init_point ?? result?.initPoint ?? null;
  const preapprovalId = result?.id ?? null;

  await prisma.checkoutSession.update({
    where: { id: checkoutSession.id },
    data: {
      mercadopagoPreapprovalId: preapprovalId,
      checkoutUrl,
    },
  });

  const { getMercadoPagoCheckoutHints } = mercadopagoService;

  return {
    checkoutUrl,
    providerId: PAYMENT_PROVIDER_MP_PREAPPROVAL,
    mercadopagoPreapprovalId: preapprovalId,
    checkoutHints: getMercadoPagoCheckoutHints(payerEmail),
  };
}

/**
 * Checkout para change-plan / reactivate con provider explícito.
 */
async function createBillingCheckoutWithPendingChange({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  when,
  paymentProvider: rawProvider,
  pendingChangeFromSubscriptionId,
  createSubscriptionOptions = {},
}) {
  const paymentProvider = normalizePaymentProvider(rawProvider);

  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO && when !== 'now') {
    const err = new Error(
      'Cambio de plan al vencer el periodo requiere débito automático Mercado Pago. Usa activación inmediata con tarjeta o el método automático.',
    );
    err.statusCode = 400;
    throw err;
  }

  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) {
    const err = new Error('Plan no encontrado.');
    err.statusCode = 400;
    throw err;
  }
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      organizationId,
      userId,
      planId: plan.id,
      status: 'pending',
      expiresAt,
      paymentProvider,
      pendingChangeFromSubscriptionId: pendingChangeFromSubscriptionId || null,
    },
  });

  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO) {
    const result = await mercadopagoCheckoutProService.createCheckoutPreference({
      organizationId,
      userId,
      payerEmail,
      planSKU,
      restaurantId,
      checkoutSessionId: checkoutSession.id,
    });
    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: { mercadopagoPreferenceId: result.id, checkoutUrl: result.init_point },
    });
    return {
      checkoutUrl: result.init_point,
      providerId: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      checkoutHints: mercadopagoCheckoutProService.getCheckoutProHints(),
    };
  }

  const result = await mercadopagoService.createSubscription(
    organizationId,
    userId,
    payerEmail,
    planSKU,
    restaurantId,
    createSubscriptionOptions,
  );
  const checkoutUrl = result?.init_point ?? result?.initPoint ?? null;
  await prisma.checkoutSession.update({
    where: { id: checkoutSession.id },
    data: { mercadopagoPreapprovalId: result?.id, checkoutUrl },
  });
  return {
    checkoutUrl,
    providerId: PAYMENT_PROVIDER_MP_PREAPPROVAL,
    checkoutHints: mercadopagoService.getMercadoPagoCheckoutHints(payerEmail),
  };
}

module.exports = {
  createBillingCheckout,
  createBillingCheckoutWithPendingChange,
  checkoutProSupportsWhen,
};
