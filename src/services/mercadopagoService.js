/**
 * MercadoPago PreApproval para SimpleReserva.
 *
 * Modelo de la app:
 * - Planes: basico, profesional, premium. Precio cada 2 semanas (14 días).
 * - Trial 14 días → luego pago. Suscripción activa = cobros recurrentes.
 *
 * MP API preapproval: frequency_type válidos = [days, months].
 * Usamos days/14 para cobro quincenal (billingFrequencyDays = cada 2 semanas).
 */

const prisma = require('../lib/prisma');
const planService = require('./planService');

const CURRENCY = 'CLP';
const MIN_AMOUNT_CLP = 950; // MP rechaza montos menores con 400/500

let preApprovalClient = null;

function getClient() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
  }
  if (!preApprovalClient) {
    const { MercadoPagoConfig, PreApproval } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });
    preApprovalClient = new PreApproval(client);
  }
  return preApprovalClient;
}

/**
 * Obtiene el monto efectivo para un plan (base + PlanOverride del owner).
 */
async function getEffectiveAmount(plan, ownerId) {
  const config = await planService.getPlanConfig(plan);
  const baseAmount = config?.biweeklyPriceCLP ?? 4990;
  const override = ownerId ? await planService.getPlanOverride(ownerId) : null;
  if (override?.biweeklyPriceCLP != null) {
    return override.biweeklyPriceCLP;
  }
  return baseAmount;
}

/**
 * Crea preapproval en MP. Redirige al checkout para que el usuario pague.
 *
 * @param {string} restaurantId
 * @param {string} ownerId - para aplicar PlanOverride
 * @param {string} backUrl
 * @param {string} payerEmail
 * @param {string} plan - basico | profesional | premium
 */
async function createSubscription(restaurantId, ownerId, backUrl, payerEmail, plan = 'profesional') {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) throw new Error('Restaurante no encontrado');

  const biweeklyAmount = await getEffectiveAmount(plan, ownerId);
  const config = await planService.getPlanConfig(plan);
  const billingDays = config?.billingFrequencyDays ?? 14;
  let amount = Math.round(biweeklyAmount);
  if (amount < MIN_AMOUNT_CLP) {
    amount = MIN_AMOUNT_CLP;
  }

  const isTestMode =
    process.env.MERCADOPAGO_TEST_MODE === 'true' ||
    (process.env.MERCADOPAGO_ACCESS_TOKEN || '').startsWith('TEST-');
  const emailForPayer = isTestMode
    ? (process.env.MP_TEST_PAYER_EMAIL || '').trim()
    : (payerEmail || '').trim();

  if (!emailForPayer) {
    throw new Error(
      isTestMode
        ? 'Modo prueba: define MP_TEST_PAYER_EMAIL en .env (Usuario del Comprador de prueba)'
        : 'payer_email es requerido'
    );
  }

  const effectiveBackUrl = (backUrl || process.env.BACKEND_PUBLIC_URL || '').trim();
  if (!effectiveBackUrl) {
    throw new Error('Configura BACKEND_PUBLIC_URL en .env (ej: URL de ngrok)');
  }

  const externalRef = `${restaurantId}|${plan}`;
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 2);

  // Body: cobro quincenal. notification_url es OBLIGATORIO para suscripciones:
  // MP no usa la URL del panel de webhooks, hay que pasarla en cada preapproval.
  const backendBase = (process.env.BACKEND_PUBLIC_URL || effectiveBackUrl).replace(/\/$/, '');
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;

  const body = {
    reason: `SimpleReserva ${plan} - ${restaurant.name}`,
    external_reference: externalRef,
    payer_email: emailForPayer,
    status: 'pending',
    auto_recurring: {
      frequency: billingDays,
      frequency_type: 'days',
      end_date: endDate.toISOString(),
      transaction_amount: amount,
      currency_id: CURRENCY,
    },
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
  };

  console.log('[MercadoPago] Request (sanitized):', {
    payer_email: emailForPayer,
    amount,
    frequency: `cada ${billingDays} días`,
    currency_id: CURRENCY,
    back_url: effectiveBackUrl.slice(0, 50) + '...',
    notification_url: notificationUrl,
    tokenPrefix: (process.env.MERCADOPAGO_ACCESS_TOKEN || '').slice(0, 15),
  });

  try {
    const client = getClient();
    const result = await client.create({ body });
    return result;
  } catch (err) {
    const errBody = typeof err === 'object' && err !== null ? err : {};
    const msg = errBody?.message ?? err?.error ?? err?.message ?? 'Error MercadoPago';
    const status = errBody?.status ?? errBody?.statusCode;

    console.error('[MercadoPago]', msg);
    console.error('[MercadoPago] Response:', JSON.stringify(errBody, null, 2));

    let userMsg = msg;
    if (status === 500 || String(msg).toLowerCase().includes('internal')) {
      userMsg =
        'MercadoPago no disponible. Verifica MERCADOPAGO_ACCESS_TOKEN (debe ser del Vendedor de prueba) y MP_TEST_PAYER_EMAIL. Ver docs/MERCADOPAGO_TEST_SETUP.md';
    } else if (String(msg).toLowerCase().includes('payer') || String(msg).toLowerCase().includes('email')) {
      userMsg = 'Email inválido. En prueba: MP_TEST_PAYER_EMAIL = Usuario exacto del Comprador de prueba.';
    } else if (String(msg).toLowerCase().includes('both') || String(msg).toLowerCase().includes('real or test')) {
      userMsg = 'Token y comprador deben ser ambos de prueba. Usa token del Vendedor + MP_TEST_PAYER_EMAIL del Comprador.';
    }

    const e = new Error(userMsg);
    e.cause = err;
    throw e;
  }
}

async function cancelSubscription(preapprovalId) {
  try {
    const client = getClient();
    await client.update({
      id: preapprovalId,
      body: { status: 'cancelled' },
    });
  } catch (err) {
    const msg = err?.message ?? err?.error ?? 'Error al cancelar';
    console.error('[MercadoPago] cancelSubscription:', msg);
    throw new Error(msg);
  }
}

async function activateRestaurantSubscription(restaurantId, preapprovalId, plan = 'profesional') {
  const existing = await prisma.subscription.findFirst({
    where: { mercadopagoPreapprovalId: preapprovalId, status: 'active' },
  });
  if (existing) return;

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    console.error('[MercadoPago] activateRestaurantSubscription: restaurante no encontrado:', restaurantId);
    throw new Error(`Restaurante no encontrado: ${restaurantId}`);
  }

  const validPlan = planService.VALID_PLANS.includes(plan) ? plan : 'profesional';

  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { restaurantId, status: 'trial' },
      data: { status: 'cancelled' },
    });
    await tx.subscription.create({
      data: {
        restaurantId,
        plan: validPlan,
        status: 'active',
        mercadopagoPreapprovalId: preapprovalId,
      },
    });
    await tx.restaurant.update({
      where: { id: restaurantId },
      data: { trialEndsAt: null },
    });
  });
}

async function deactivateRestaurantSubscription(restaurantId) {
  await prisma.subscription.updateMany({
    where: { restaurantId },
    data: { status: 'expired', endDate: new Date() },
  });
}

async function enterGracePeriod(restaurantId) {
  const graceEnd = new Date();
  graceEnd.setDate(graceEnd.getDate() + 7);
  await prisma.subscription.updateMany({
    where: { restaurantId, status: 'active' },
    data: { status: 'grace', gracePeriodEndsAt: graceEnd },
  });
}

/**
 * Confirma suscripción desde preapproval_id (fallback cuando el webhook no llega).
 * Usado cuando el usuario vuelve de MP con preapproval_id en la URL.
 */
async function confirmSubscriptionFromPreapproval(restaurantId, preapprovalId) {
  const client = getClient();
  let mpSub;
  try {
    mpSub = await client.get({ id: preapprovalId });
  } catch (err) {
    console.error('[MercadoPago] confirmSubscriptionFromPreapproval get failed:', err?.message ?? err);
    throw new Error('No se pudo verificar el pago con MercadoPago');
  }

  const externalRef = mpSub?.external_reference ? String(mpSub.external_reference) : '';
  const parts = externalRef.split('|');
  const refRestaurantId = parts[0];
  const plan = parts[1] || 'profesional';

  if (refRestaurantId !== restaurantId) {
    return { activated: false, reason: 'La suscripción no corresponde a este restaurante' };
  }

  const status = mpSub?.status ?? mpSub?.Status ?? null;
  const isAuthorized = status === 'authorized' || status === 'approved';

  if (!isAuthorized) {
    return { activated: false, reason: `Pago aún no autorizado (estado: ${status || 'desconocido'})` };
  }

  await activateRestaurantSubscription(restaurantId, preapprovalId, plan);
  console.log('[MercadoPago] confirmSubscriptionFromPreapproval activated:', restaurantId, plan);
  return { activated: true };
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateRestaurantSubscription,
  deactivateRestaurantSubscription,
  enterGracePeriod,
  confirmSubscriptionFromPreapproval,
};
