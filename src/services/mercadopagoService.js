/**
 * MercadoPago PreApproval para SimpleReserva.
 *
 * Modelo de la app:
 * - Planes: basico, profesional, premium. Precio cada 2 semanas (14 días).
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
  const baseAmount = config?.priceCLP ?? 4990;
  const override = ownerId ? await planService.getPlanOverride(ownerId) : null;
  if (override?.priceCLP != null) {
    return override.priceCLP;
  }
  return baseAmount;
}

/**
 * Crea preapproval en MP. Redirige al checkout para que el usuario pague.
 *
 * @param {string} organizationId
 * @param {string} ownerId - para aplicar PlanOverride
 * @param {string} backUrl
 * @param {string} payerEmail
 * @param {string} plan - basico | profesional | premium
 */
async function createSubscription(organizationId, ownerId, backUrl, payerEmail, plan = 'profesional') {
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const planAmount = await getEffectiveAmount(plan, ownerId);
  const config = await planService.getPlanConfig(plan);
  const mpFreq = planService.toMercadoPagoFrequency(config?.billingFrequency ?? 1, config?.billingFrequencyType ?? 'months');
  let amount = Math.round(planAmount);
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

  const externalRef = `${organizationId}|${plan}`;
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 2);

  // Body: cobro quincenal. notification_url es OBLIGATORIO para suscripciones:
  // MP no usa la URL del panel de webhooks, hay que pasarla en cada preapproval.
  const backendBase = (process.env.BACKEND_PUBLIC_URL || effectiveBackUrl).replace(/\/$/, '');
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;

  const body = {
    reason: `SimpleReserva ${plan} - ${organization.name}`,
    external_reference: externalRef,
    payer_email: emailForPayer,
    status: 'pending',
    auto_recurring: {
      frequency: mpFreq.frequency,
      frequency_type: mpFreq.frequency_type,
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
    frequency: `${mpFreq.frequency} ${mpFreq.frequency_type}`,
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

async function activateOrganizationSubscription(organizationId, preapprovalId, plan = 'profesional') {
  const existing = await prisma.subscription.findFirst({
    where: { mercadopagoPreapprovalId: preapprovalId, status: 'active' },
  });
  if (existing) return;

  const organization = await prisma.restaurantOrganization.findUnique({ where: { id: organizationId } });
  if (!organization) {
    console.error('[MercadoPago] activateOrganizationSubscription: organización no encontrada:', organizationId);
    throw new Error(`Organización no encontrada: ${organizationId}`);
  }

  const validPlan = planService.VALID_PLANS.includes(plan) ? plan : 'profesional';

  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { organizationId, status: 'trial' },
      data: { status: 'cancelled' },
    });
    await tx.subscription.create({
      data: {
        organizationId,
        plan: validPlan,
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
      const panelBase = (process.env.APP_URL || process.env.RESTAURANT_PANEL_URL || 'http://localhost:5175').replace(/\/$/, '');
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
  const refOrganizationId = parts[0];
  const plan = parts[1] || 'profesional';

  if (refOrganizationId !== organizationId) {
    return { activated: false, reason: 'La suscripción no corresponde a esta organización' };
  }

  const status = mpSub?.status ?? mpSub?.Status ?? null;
  const isAuthorized = status === 'authorized' || status === 'approved';

  if (!isAuthorized) {
    return { activated: false, reason: `Pago aún no autorizado (estado: ${status || 'desconocido'})` };
  }

  await activateOrganizationSubscription(organizationId, preapprovalId, plan);
  console.log('[MercadoPago] confirmSubscriptionFromPreapproval activated:', organizationId, plan);
  return { activated: true };
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateOrganizationSubscription,
  deactivateOrganizationSubscription,
  enterGracePeriod,
  confirmSubscriptionFromPreapproval,
};
