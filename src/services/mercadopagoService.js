/**
 * MercadoPago PreApproval para SimpleReserva.
 *
 * Modelo de la app:
 * - Planes: basico, profesional, premium.
 * - Trial 14 días → luego pago. Suscripción activa = cobros recurrentes.
 *
 * MP API preapproval: frequency_type válidos = [days, months].
 * Usamos el helper planService.toMercadoPagoFrequency para mapear days/weeks/months/yearly.
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
const { MercadoPagoConfig, PreApproval, PreApprovalPlan } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });
    preApprovalClient = new PreApproval(client);
    preApprovalPlanClient = new PreApprovalPlan(client);
  }
  return { preApprovalClient, preApprovalPlanClient };
}

/**
 * Crea preapproval_plan en MP.
 */
async function createMPPreapprovalPlan(plan) {
  const { preApprovalPlanClient } = getClient();
  const mpFreq = planService.toMercadoPagoFrequency(plan.billingFrequency, plan.billingFrequencyType);
  
  let backUrl = (process.env.BACKEND_PUBLIC_URL || process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'https://www.google.com').trim();
  
  // MercadoPago preapproval_plan API often rejects localhost URLs.
  // Since this is just a default back_url for the plan, we use a placeholder if it's localhost.
  if (backUrl.includes('localhost') || backUrl.includes('127.0.0.1')) {
    console.log(`[MercadoPago] Plan back_url is localhost (${backUrl}), using placeholder for MP API compatibility.`);
    backUrl = 'https://www.google.com'; 
  }

  const body = {
    reason: plan.name,
    auto_recurring: {
      frequency: mpFreq.frequency,
      frequency_type: mpFreq.frequency_type,
      transaction_amount: Math.round(Number(plan.priceCLP)),
      currency_id: CURRENCY,
    },
    back_url: backUrl,
  };

  console.log('[MercadoPago] Creating PreApprovalPlan:', JSON.stringify(body, null, 2));

  return await preApprovalPlanClient.create({ body });
}

/**
 * Actualiza preapproval_plan en MP.
 */
async function updateMPPreapprovalPlan(mpPlanId, plan) {
  const { preApprovalPlanClient } = getClient();
  const mpFreq = planService.toMercadoPagoFrequency(plan.billingFrequency, plan.billingFrequencyType);

  const body = {
    reason: plan.name,
    auto_recurring: {
      frequency: mpFreq.frequency,
      frequency_type: mpFreq.frequency_type,
      transaction_amount: Math.round(Number(plan.priceCLP)),
    },
  };

  return await preApprovalPlanClient.update({ id: mpPlanId, body });
}

/**
 * Sincroniza un plan de la DB con MercadoPago.
 */
async function syncPlanToMercadoPago(planId) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error('Plan no encontrado');

  let result;
  if (plan.mercadopagoPreapprovalPlanId) {
    try {
      result = await updateMPPreapprovalPlan(plan.mercadopagoPreapprovalPlanId, plan);
    } catch (err) {
      console.error('[MercadoPago] syncPlanToMercadoPago update failed, attempting create:', err.message);
      // Si falla el update (ej: plan borrado en MP), intentamos crear uno nuevo
      result = await createMPPreapprovalPlan(plan);
    }
  } else {
    result = await createMPPreapprovalPlan(plan);
  }

  const updatedPlan = await prisma.plan.update({
    where: { id: planId },
    data: {
      mercadopagoPreapprovalPlanId: result.id,
      mercadopagoInitPoint: result.init_point || result.initPoint,
      mercadopagoLastSyncAt: new Date(),
    },
  });

  return updatedPlan;
}

/**
 * Crea preapproval en MP. Redirige al checkout para que el usuario pague.
 *
 * @param {string} organizationId
 * @param {string} ownerId
 * @param {string} payerEmail
 * @param {string} planSKU - plan-basico | plan-profesional | plan-premium
 */
async function createSubscription(organizationId, ownerId, payerEmail, planSKU = 'plan-profesional') {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const config = await planService.getPlanConfig(planSKU);
  if (!config) throw new Error(`Plan no encontrado: ${planSKU}`);

  const planAmount = Number(config.priceCLP);
  const mpFreq = planService.toMercadoPagoFrequency(config.billingFrequency, config.billingFrequencyType);
  let amount = Math.round(planAmount);
  if (amount < MIN_AMOUNT_CLP) {
    amount = MIN_AMOUNT_CLP;
  }

  let effectiveBackUrl = (process.env.FRONTEND_RESTAURANT_PORTAL_URL || '').trim();
  if (!effectiveBackUrl) {
    throw new Error('FRONTEND_RESTAURANT_PORTAL_URL is not set in .env');
  }

  // MercadoPago rejects localhost URLs -- use a placeholder for local dev.
  // The user will still return to the correct URL via the browser's redirect chain.
  if (effectiveBackUrl.includes('localhost') || effectiveBackUrl.includes('127.0.0.1')) {
    effectiveBackUrl = 'https://www.mercadopago.cl';
  }

  const externalRef = `${organizationId}|${planSKU}`;

  // Webhooks only: must be the public backend (never the restaurant frontend URL).
  const backendBase = (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;

  const planInDb = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  const hasTrial = planInDb?.freeTrialLength && planInDb.freeTrialLength > 0;

  // MercadoPago requires start_date to be in the future. Set to 2 minutes from now for immediate charges.
  // This ensures the first charge happens as soon as the subscription is authorized.
  const startDate = new Date();
  startDate.setMinutes(startDate.getMinutes() + 2);

  const autoRecurring = {
    frequency: mpFreq.frequency,
    frequency_type: mpFreq.frequency_type,
    transaction_amount: amount,
    currency_id: CURRENCY,
    ...(!hasTrial ? { start_date: startDate.toISOString() } : {}),
    ...(hasTrial ? {
      free_trial: {
        frequency: planInDb.freeTrialLength,
        frequency_type: planInDb.freeTrialLengthUnit || 'months',
      },
    } : {}),
  };

  const body = {
    reason: `SimpleReserva ${config.name} - ${organization.name}`,
    external_reference: externalRef,
    payer_email: (payerEmail || '').trim(),
    status: 'pending',
    auto_recurring: autoRecurring,
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
  };

  console.log('[MercadoPago] Request (sanitized):', {
    amount,
    frequency: `${mpFreq.frequency} ${mpFreq.frequency_type}`,
    currency_id: CURRENCY,
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
    tokenPrefix: (process.env.MERCADOPAGO_ACCESS_TOKEN || '').slice(0, 15),
    hasTrial,
    start_date: !hasTrial ? startDate.toISOString() : 'N/A (has trial)',
  });
  console.log('[MercadoPago] Full notification_url being sent to MP:', notificationUrl);
  console.log('[MercadoPago] Start date for subscription:', !hasTrial ? startDate.toISOString() : 'N/A (has trial)');
  console.log('[MercadoPago] NOTE: MP will send POST requests to this URL when events occur (payment authorized, subscription status changes, etc.)');

  try {
    const { preApprovalClient } = getClient();
    const result = await preApprovalClient.create({ body });
    return result;
  } catch (err) {
    const errBody = typeof err === 'object' && err !== null ? err : {};
    const msg = errBody?.message ?? err?.error ?? err?.message ?? 'Error MercadoPago';
    const status = errBody?.status ?? errBody?.statusCode;

    console.error('[MercadoPago]', msg);
    console.error('[MercadoPago] Response:', JSON.stringify(errBody, null, 2));

    let userMsg = msg;
    if (status === 500 || String(msg).toLowerCase().includes('internal')) {
      userMsg = 'MercadoPago no disponible. Verifica MERCADOPAGO_ACCESS_TOKEN.';
    }

    const e = new Error(userMsg);
    e.cause = err;
    throw e;
  }
}

async function cancelSubscription(preapprovalId) {
  try {
    const { preApprovalClient } = getClient();
    await preApprovalClient.update({
      id: preapprovalId,
      body: { status: 'cancelled' },
    });
  } catch (err) {
    const msg = err?.message ?? err?.error ?? 'Error al cancelar';
    console.error('[MercadoPago] cancelSubscription:', msg);
    throw new Error(msg);
  }
}

async function activateOrganizationSubscription(organizationId, preapprovalId, planSKU = 'plan-profesional') {
  const existing = await prisma.subscription.findFirst({
    where: { mercadopagoPreapprovalId: preapprovalId, status: 'active' },
  });
  if (existing) return;

  const organization = await prisma.restaurantOrganization.findUnique({ where: { id: organizationId } });
  if (!organization) {
    console.error('[MercadoPago] activateOrganizationSubscription: organización no encontrada:', organizationId);
    throw new Error(`Organización no encontrada: ${organizationId}`);
  }

  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) {
    console.error('[MercadoPago] activateOrganizationSubscription: plan no encontrado:', planSKU);
    throw new Error(`Plan no encontrado: ${planSKU}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { organizationId, status: 'trial' },
      data: { status: 'cancelled' },
    });
    await tx.subscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: 'active',
        mercadopagoPreapprovalId: preapprovalId,
      },
    });
    await tx.restaurantOrganization.update({
      where: { id: organizationId },
      data: { trialEndsAt: null },
    });
  });
}

async function deactivateOrganizationSubscription(organizationId) {
  await prisma.subscription.updateMany({
    where: { organizationId },
    data: { status: 'expired', endDate: new Date() },
  });
}

async function enterGracePeriod(organizationId) {
  const graceEnd = new Date();
  graceEnd.setDate(graceEnd.getDate() + 7);
  await prisma.subscription.updateMany({
    where: { organizationId, status: 'active' },
    data: { status: 'grace', gracePeriodEndsAt: graceEnd },
  });

  // Notify owners by email
  try {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: {
      name: true,
      owner: { select: { email: true } },
    },
  });
    if (organization && organization.owner?.email) {
      const emails = [organization.owner.email];
      const panelBase = (process.env.FRONTEND_RESTAURANT_PORTAL_URL || process.env.RESTAURANT_PANEL_URL || 'http://localhost:5175').replace(/\/$/, '');
      const panelUrl = `${panelBase}/billing?organizationId=${organizationId}`;
      const { sendPaymentFailureNotification } = require('./notificationService');
      await sendPaymentFailureNotification({
        emails,
        restaurantName: organization.name,
        panelUrl,
      });
    }
  } catch (err) {
    console.error('[MercadoPago] enterGracePeriod: failed to send payment failure email:', err?.message ?? err);
  }
}

/**
 * Confirma suscripción desde preapproval_id (fallback cuando el webhook no llega).
 * Usado cuando el usuario vuelve de MP con preapproval_id en la URL.
 */
async function confirmSubscriptionFromPreapproval(organizationId, preapprovalId) {
  const { preApprovalClient } = getClient();
  let mpSub;
  try {
    mpSub = await preApprovalClient.get({ id: preapprovalId });
  } catch (err) {
    console.error('[MercadoPago] confirmSubscriptionFromPreapproval get failed:', err?.message ?? err);
    throw new Error('No se pudo verificar el pago con MercadoPago');
  }

  const externalRef = mpSub?.external_reference ? String(mpSub.external_reference) : '';
  const parts = externalRef.split('|');
  const refOrganizationId = parts[0];
  const planSKU = parts[1] || 'plan-profesional';

  if (refOrganizationId !== organizationId) {
    return { activated: false, reason: 'La suscripción no corresponde a esta organización' };
  }

  const status = mpSub?.status ?? mpSub?.Status ?? null;
  const isAuthorized = status === 'authorized' || status === 'approved';

  if (!isAuthorized) {
    return { activated: false, reason: `Pago aún no autorizado (estado: ${status || 'desconocido'})` };
  }

  await activateOrganizationSubscription(organizationId, preapprovalId, planSKU);
  console.log('[MercadoPago] confirmSubscriptionFromPreapproval activated:', organizationId, planSKU);
  return { activated: true };
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateOrganizationSubscription,
  deactivateOrganizationSubscription,
  enterGracePeriod,
  confirmSubscriptionFromPreapproval,
  syncPlanToMercadoPago,
};
