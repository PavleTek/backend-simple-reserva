/**
 * Mercado Pago Checkout Pro (Preferences API).
 * Acepta tarjetas locales e internacionales en CLP sin la restricción país del pagador de Preapproval.
 * @see https://www.mercadopago.cl/developers/es/docs/checkout-pro
 */

const prisma = require('../lib/prisma');
const {
  getMercadoPagoAccessToken,
  describeMercadoPagoCredentialChoice,
} = require('../lib/mercadopagoEnv');
const {
  PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
  buildCheckoutProExternalReference,
  parseExternalReference,
} = require('../lib/billingProviders');
const { parseExternalReferenceV2 } = require('../lib/externalReferenceV2');
const { computePeriodEnd } = require('../lib/billingPeriod');
const planService = require('./planService');

const CURRENCY = 'CLP';
const MIN_AMOUNT_CLP = 950;
const IVA_RATE = 0.19;

let preferenceClient = null;
let paymentClient = null;
let cachedAccessToken = null;

function getClients() {
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
  }
  if (!preferenceClient || cachedAccessToken !== accessToken) {
    const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });
    preferenceClient = new Preference(client);
    paymentClient = new Payment(client);
    cachedAccessToken = accessToken;
  }
  return { preferenceClient, paymentClient };
}

function resolveBackUrls(restaurantId) {
  const backendBase = (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
    /\/$/,
    '',
  );
  let backUrl = restaurantId
    ? `${backendBase}/api/redirect-to-billing/${restaurantId}`
    : `${backendBase}/api/redirect-to-billing`;
  if (backUrl.includes('localhost') || backUrl.includes('127.0.0.1')) {
    backUrl = 'https://www.mercadopago.cl';
  }
  return {
    success: backUrl,
    failure: backUrl,
    pending: backUrl,
  };
}

function parseCheckoutProRef(externalRef) {
  return parseExternalReferenceV2(externalRef) || parseExternalReference(externalRef);
}

function computeAmountWithIva(priceCLP) {
  let amount = Math.round(Number(priceCLP) * (1 + IVA_RATE));
  if (amount < MIN_AMOUNT_CLP) amount = MIN_AMOUNT_CLP;
  return amount;
}

function getCheckoutProHints() {
  return {
    title: 'Pago en Mercado Pago',
    lines: [
      'Pago en mercadopago.cl (pesos chilenos, CLP).',
      'Puedes pagar con tarjeta chilena o internacional (Visa, Mastercard, etc.).',
      'No necesitas cuenta Mercado Pago de Chile si pagas con tarjeta.',
      'Este método no es débito automático: recibirás un enlace cada mes para renovar (o activa débito automático con la otra opción).',
    ],
  };
}

/**
 * Crea preferencia Checkout Pro y devuelve init_point.
 */
async function createCheckoutPreference({
  organizationId,
  userId,
  payerEmail,
  planSKU,
  restaurantId,
  checkoutSessionId,
}) {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, billingEmail: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const config = await planService.getPlanConfig(planSKU);
  if (!config) throw new Error(`Plan no encontrado: ${planSKU}`);

  const amount = computeAmountWithIva(config.priceCLP);
  const externalRef = buildCheckoutProExternalReference(organizationId, planSKU, checkoutSessionId);

  const backendBase = (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
    /\/$/,
    '',
  );
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;
  const backUrls = resolveBackUrls(restaurantId);

  const payer = {};
  const email = (payerEmail || organization.billingEmail || '').trim();
  if (email) payer.email = email;

  const body = {
    items: [
      {
        id: planSKU,
        title: `SimpleReserva ${config.name}`.slice(0, 256),
        description: `Suscripción ${organization.name}`.slice(0, 256),
        quantity: 1,
        unit_price: amount,
        currency_id: CURRENCY,
      },
    ],
    payer: Object.keys(payer).length ? payer : undefined,
    external_reference: externalRef,
    notification_url: notificationUrl,
    back_urls: backUrls,
    auto_return: 'approved',
    statement_descriptor: 'SIMPLERESERVA',
    metadata: {
      organization_id: organizationId,
      user_id: userId,
      plan_sku: planSKU,
      checkout_session_id: checkoutSessionId,
      payment_provider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
    },
  };

  console.log('[MercadoPago Checkout Pro] create preference:', {
    external_reference: externalRef,
    amount,
    credential: describeMercadoPagoCredentialChoice()?.source,
  });

  const { preferenceClient: pref } = getClients();
  const result = await pref.create({ body });

  const initPoint = result?.init_point ?? result?.sandbox_init_point ?? null;
  const preferenceId = result?.id ?? null;

  if (!initPoint) {
    throw new Error('Mercado Pago no devolvió enlace de pago (Checkout Pro).');
  }

  return {
    id: preferenceId,
    init_point: initPoint,
    initPoint,
    external_reference: externalRef,
  };
}

/**
 * Activa suscripción tras pago Checkout Pro aprobado.
 */
async function activateFromCheckoutProPayment(organizationId, planSKU, checkoutSessionId, options = {}) {
  const mercadopagoService = require('./mercadopagoService');
  const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');
  await mercadopagoService.activateOrganizationSubscription(organizationId, null, planSKU, {
    ...options,
    paymentProvider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
    billingStrategy: BILLING_STRATEGY_MANUAL,
    paymentProviderPsp: 'mercadopago',
    providerCheckoutSessionId: checkoutSessionId,
  });
}

function isRenewalPayment(mpPayment, checkoutSessionId) {
  const meta = mpPayment?.metadata || {};
  if (meta.renewal === true || meta.renewal === 'true') return true;
  return String(checkoutSessionId || '').startsWith('renewal-');
}

/**
 * Renueva periodo de una suscripción Checkout Pro existente (sin crear sub nueva).
 */
async function processCheckoutProRenewal(mpPayment, parsed) {
  const { organizationId, planSKU } = parsed;
  const meta = mpPayment?.metadata || {};
  const subscriptionId = meta.subscription_id;

  if (!subscriptionId) {
    return { handled: true, activated: false, reason: 'missing_subscription_id' };
  }

  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, organizationId, billingStrategy: 'manual_monthly' },
    include: { plan: true },
  });
  if (!sub) {
    return { handled: true, activated: false, reason: 'subscription_not_found' };
  }

  const baseDate = sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > new Date()
    ? new Date(sub.currentPeriodEnd)
    : new Date();
  const clearingReferralWindow = !!sub.referralFreeUntil;
  const nextPeriodEnd = clearingReferralWindow
    ? computePeriodEnd(new Date(), sub.plan)
    : computePeriodEnd(baseDate, sub.plan);

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'active',
      isActiveSubscription: true,
      gracePeriodEndsAt: null,
      currentPeriodEnd: nextPeriodEnd,
      ...(clearingReferralWindow ? { referralFreeUntil: null } : {}),
    },
  });

  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: { trialEndsAt: null },
  });

  planService.invalidateCache(organizationId);

  if (clearingReferralWindow) {
    try {
      const referralService = require('./referralService');
      await referralService.markFirstPayment(organizationId);
    } catch (refErr) {
      console.warn('[CheckoutPro] markFirstPayment after free window:', refErr?.message ?? refErr);
    }
  }

  try {
    const { resolveBillingAlerts } = require('./billing/billingEmailService');
    await resolveBillingAlerts(organizationId, ['period_overdue', 'grace_entered', 'payment_rejected']);
  } catch (alertErr) {
    console.warn('[CheckoutPro] resolveBillingAlerts:', alertErr?.message ?? alertErr);
  }

  return { handled: true, activated: true, renewed: true, organizationId, planSKU };
}

/**
 * Procesa pago MP (webhook o confirm) para Checkout Pro.
 */
/**
 * Preferencia Checkout Pro para recovery (periodo en mora).
 */
async function createRecoveryPreference({
  organizationId,
  payerEmail,
  plan,
  restaurantId,
  checkoutSessionId,
  externalReference,
  subscriptionId,
}) {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true, billingEmail: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const amount = computeAmountWithIva(plan.priceCLP);
  const backendBase = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;
  const backUrls = resolveBackUrls(restaurantId);
  const email = (payerEmail || organization.billingEmail || '').trim();

  const body = {
    items: [
      {
        id: `${plan.productSKU}-recovery`,
        title: `Regularizar pago SimpleReserva ${plan.name}`.slice(0, 256),
        quantity: 1,
        unit_price: amount,
        currency_id: CURRENCY,
      },
    ],
    payer: email ? { email } : undefined,
    external_reference: externalReference,
    notification_url: notificationUrl,
    back_urls: backUrls,
    auto_return: 'approved',
    metadata: {
      organization_id: organizationId,
      plan_sku: plan.productSKU,
      checkout_session_id: checkoutSessionId,
      subscription_id: subscriptionId,
      purpose: 'recovery',
      payment_provider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
      schemaVersion: 2,
    },
  };

  const { preferenceClient: pref } = getClients();
  const result = await pref.create({ body });
  const initPoint = result?.init_point ?? result?.sandbox_init_point ?? null;
  if (!initPoint) throw new Error('No se pudo generar link de recuperación.');

  return { checkoutUrl: initPoint, preferenceId: result?.id };
}

/**
 * Recupera suscripción en grace tras pago recovery (sin crear sub nueva).
 */
async function processRecoveryPayment(mpPayment, parsed) {
  const { organizationId, planSKU } = parsed;
  const meta = mpPayment?.metadata || {};
  const subscriptionId = meta.subscription_id;

  const sub = subscriptionId
    ? await prisma.subscription.findFirst({
        where: { id: subscriptionId, organizationId },
        include: { plan: true },
      })
    : await prisma.subscription.findFirst({
        where: { organizationId, status: 'grace' },
        orderBy: { startDate: 'desc' },
        include: { plan: true },
      });

  if (!sub) {
    return { handled: true, activated: false, reason: 'subscription_not_found' };
  }

  const nextPeriodEnd = computePeriodEnd(new Date(), sub.plan);

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'active',
      isActiveSubscription: true,
      gracePeriodEndsAt: null,
      currentPeriodEnd: nextPeriodEnd,
    },
  });

  planService.invalidateCache(organizationId);

  return { handled: true, activated: true, recovered: true, organizationId, planSKU };
}

async function processCheckoutProPayment(mpPayment) {
  const externalRef = mpPayment?.external_reference;
  const parsed = parseCheckoutProRef(externalRef);
  if (!parsed || (parsed.kind !== 'checkout_pro' && parsed.provider !== 'mp_checkout_pro')) {
    return { handled: false, reason: 'not_checkout_pro' };
  }

  const { organizationId, planSKU, checkoutSessionId, purpose } = parsed;
  const metaPurpose = mpPayment?.metadata?.purpose;
  const status = mpPayment?.status;

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { isDeleted: true },
  });
  if (!org || org.isDeleted) {
    return { handled: true, skipped: true, reason: 'org_deleted' };
  }

  if (status === 'approved' && (purpose === 'recovery' || metaPurpose === 'recovery')) {
    return processRecoveryPayment(mpPayment, parsed);
  }

  if (status === 'approved' && isRenewalPayment(mpPayment, checkoutSessionId)) {
    return processCheckoutProRenewal(mpPayment, parsed);
  }

  if (status === 'approved') {
    const session = checkoutSessionId
      ? await prisma.checkoutSession.findUnique({ where: { id: checkoutSessionId } })
      : null;

    const activateOpts = session?.pendingChangeFromSubscriptionId
      ? { replaceSubscriptionId: session.pendingChangeFromSubscriptionId }
      : {};

    await activateFromCheckoutProPayment(organizationId, planSKU, checkoutSessionId, activateOpts);

    if (checkoutSessionId) {
      await prisma.checkoutSession.updateMany({
        where: { id: checkoutSessionId },
        data: { status: 'completed', completedAt: new Date() },
      });
    }

    return { handled: true, activated: true, organizationId, planSKU };
  }

  return { handled: true, activated: false, status };
}

/**
 * Confirma pago por payment_id (retorno desde MP o fallback).
 */
async function confirmPaymentFromMercadoPago(organizationId, paymentId) {
  const { paymentClient: pay } = getClients();
  let mpPayment;
  try {
    mpPayment = await pay.get({ id: paymentId });
  } catch (err) {
    const e = new Error(
      'No pudimos verificar el pago en Mercado Pago. Si no completaste el cobro, tu plan no cambió.',
    );
    e.statusCode = 400;
    throw e;
  }

  const parsed = parseCheckoutProRef(mpPayment?.external_reference);
  if (!parsed || parsed.organizationId !== organizationId) {
    const e = new Error('El pago no corresponde a esta organización.');
    e.statusCode = 400;
    throw e;
  }

  if (parsed.kind !== 'checkout_pro' && parsed.provider !== 'mp_checkout_pro') {
    return { ok: false, activated: false, message: 'Pago no es Checkout Pro' };
  }

  const result = await processCheckoutProPayment(mpPayment);
  const activated = !!result.activated;
  return {
    ok: true,
    activated,
    status: mpPayment.status,
    planSKU: parsed.planSKU,
    message: activated
      ? undefined
      : mpPayment.status === 'approved'
        ? 'Pago registrado sin cambios en la suscripción.'
        : 'Pago aún no aprobado. Si cancelaste en Mercado Pago, tu plan no cambió.',
  };
}

/**
 * Crea preferencia de renovación mensual (link de pago).
 */
async function createRenewalPreference({ organizationId, planSKU, subscriptionId, restaurantId }) {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    include: { plan: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const config = await planService.getPlanConfig(planSKU);
  if (!config) throw new Error(`Plan no encontrado: ${planSKU}`);

  const amount = computeAmountWithIva(config.priceCLP);
  const renewalSessionId = `renewal-${subscriptionId}-${Date.now()}`;
  const externalRef = buildCheckoutProExternalReference(organizationId, planSKU, renewalSessionId);

  const backendBase = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;
  const backUrls = resolveBackUrls(restaurantId);

  const body = {
    items: [
      {
        id: `${planSKU}-renewal`,
        title: `Renovación SimpleReserva ${config.name}`.slice(0, 256),
        quantity: 1,
        unit_price: amount,
        currency_id: CURRENCY,
      },
    ],
    external_reference: externalRef,
    notification_url: notificationUrl,
    back_urls: backUrls,
    auto_return: 'approved',
    metadata: {
      organization_id: organizationId,
      plan_sku: planSKU,
      subscription_id: subscriptionId,
      renewal: true,
      payment_provider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
    },
  };

  const { preferenceClient: pref } = getClients();
  const result = await pref.create({ body });
  const initPoint = result?.init_point ?? result?.sandbox_init_point ?? null;
  if (!initPoint) throw new Error('No se pudo generar link de renovación.');

  return { checkoutUrl: initPoint, preferenceId: result?.id, externalRef };
}

module.exports = {
  getCheckoutProHints,
  createCheckoutPreference,
  createRecoveryPreference,
  processCheckoutProPayment,
  confirmPaymentFromMercadoPago,
  createRenewalPreference,
  computeAmountWithIva,
};
