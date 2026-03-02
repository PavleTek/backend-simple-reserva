/**
 * MercadoPago subscription (preapproval) integration.
 * Biweekly billing. Amount and plan from PlanConfig.
 */

const prisma = require('../lib/prisma');
const planService = require('./planService');

const CURRENCY = 'CLP';
const FREQUENCY = 15;
const FREQUENCY_TYPE = 'days';
const DEFAULT_AMOUNT = 4990;

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
 * Create a preapproval subscription for a restaurant.
 * @param {string} restaurantId
 * @param {string} backUrl
 * @param {string} payerEmail
 * @param {string} payerName
 * @param {string} [plan] - 'basico' | 'profesional' | 'premium'. Default: profesional
 * Returns { initPoint: string } - URL to redirect the payer to complete authorization.
 */
async function createSubscription(restaurantId, backUrl, payerEmail, payerName, plan = 'profesional') {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) throw new Error('Restaurante no encontrado');

  let amount = DEFAULT_AMOUNT;
  const config = await planService.getPlanConfig(plan);
  if (config?.biweeklyPriceCLP) amount = config.biweeklyPriceCLP;

  const client = getClient();
  const startDate = new Date(Date.now() + 60 * 60 * 1000); // +1h to avoid "past date" (timezone/latency)

  // Store restaurantId|plan for webhook to restore correct plan
  const externalRef = `${restaurantId}|${plan}`;

  const isTestMode = (process.env.MERCADOPAGO_ACCESS_TOKEN || '').startsWith('TEST-');
  // En modo prueba: usar email neutro que no vincule cuenta real. El usuario debe iniciar sesión
  // con el Comprador de prueba (Chile) en el checkout de MP. MP_TEST_PAYER_EMAIL = usuario exacto
  // del comprador de prueba si quieres pre-vincular.
  const emailForPayer = isTestMode
    ? (process.env.MP_TEST_PAYER_EMAIL && !process.env.MP_TEST_PAYER_EMAIL.includes('el_usuario'))
      ? process.env.MP_TEST_PAYER_EMAIL
      : 'test_comprador_cl@example.com'
    : (payerEmail || undefined);
  const body = {
    preapproval_plan_id: null,
    reason: `SimpleReserva ${plan} - ${restaurant.name}`,
    external_reference: externalRef,
    payer_email: emailForPayer,
    status: 'pending',
    auto_recurring: {
      frequency: FREQUENCY,
      frequency_type: FREQUENCY_TYPE,
      start_date: startDate.toISOString(),
      transaction_amount: amount,
      currency_id: CURRENCY,
    },
    ...(backUrl ? { back_url: backUrl } : {}),
  };

  if (payerName) {
    body.payer_first_name = payerName.split(' ')[0] || payerName;
    body.payer_last_name = payerName.split(' ').slice(1).join(' ') || '';
  }

  const result = await client.create({ body });
  return result;
}

/**
 * Cancel a MercadoPago preapproval.
 */
async function cancelSubscription(preapprovalId) {
  const client = getClient();
  await client.update({
    id: preapprovalId,
    body: { status: 'cancelled' },
  });
}

/**
 * Activate subscription in our DB after MercadoPago authorization.
 * @param {string} restaurantId
 * @param {string} preapprovalId
 * @param {string} [plan] - from external_reference (restaurantId|plan). Default: profesional
 */
async function activateRestaurantSubscription(restaurantId, preapprovalId, plan = 'profesional') {
  const existing = await prisma.subscription.findFirst({
    where: { mercadopagoPreapprovalId: preapprovalId, status: 'active' },
  });
  if (existing) return;

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

/**
 * Deactivate subscription immediately (e.g. owner cancels, no grace).
 */
async function deactivateRestaurantSubscription(restaurantId) {
  await prisma.subscription.updateMany({
    where: { restaurantId },
    data: { status: 'expired', endDate: new Date() },
  });
}

/**
 * Enter 7-day grace period after payment failure (MercadoPago cancelled/expired).
 * Full access continues until gracePeriodEndsAt.
 */
async function enterGracePeriod(restaurantId) {
  const graceEnd = new Date();
  graceEnd.setDate(graceEnd.getDate() + 7);
  await prisma.subscription.updateMany({
    where: { restaurantId, status: 'active' },
    data: { status: 'grace', gracePeriodEndsAt: graceEnd },
  });
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateRestaurantSubscription,
  deactivateRestaurantSubscription,
  enterGracePeriod,
  DEFAULT_AMOUNT,
};
