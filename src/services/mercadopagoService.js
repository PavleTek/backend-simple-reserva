/**
 * MercadoPago subscription (preapproval) integration.
 * Biweekly billing: $4,990 CLP every 15 days.
 */

const prisma = require('../lib/prisma');

const SUBSCRIPTION_AMOUNT = 4990;
const CURRENCY = 'CLP';
const FREQUENCY = 15;
const FREQUENCY_TYPE = 'days';

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
 * Returns { initPoint: string } - URL to redirect the payer to complete authorization.
 */
async function createSubscription(restaurantId, backUrl, payerEmail, payerName) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) throw new Error('Restaurante no encontrado');

  const client = getClient();
  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);

  const body = {
    preapproval_plan_id: null,
    reason: `SimpleReserva - ${restaurant.name}`,
    external_reference: restaurantId,
    payer_email: payerEmail || undefined,
    auto_recurring: {
      frequency: FREQUENCY,
      frequency_type: FREQUENCY_TYPE,
      start_date: startDate.toISOString().split('T')[0],
      end_date: null,
      transaction_amount: SUBSCRIPTION_AMOUNT,
      currency_id: CURRENCY,
    },
    back_url: backUrl || undefined,
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
 */
async function activateRestaurantSubscription(restaurantId, preapprovalId) {
  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { restaurantId, status: 'trial' },
      data: { status: 'cancelled' },
    });
    await tx.subscription.create({
      data: {
        restaurantId,
        plan: 'profesional',
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
 * Deactivate subscription (e.g. after MercadoPago cancellation webhook).
 */
async function deactivateRestaurantSubscription(restaurantId) {
  await prisma.subscription.updateMany({
    where: { restaurantId },
    data: { status: 'expired', endDate: new Date() },
  });
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateRestaurantSubscription,
  deactivateRestaurantSubscription,
  SUBSCRIPTION_AMOUNT,
};
