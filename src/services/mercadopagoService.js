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
const { computePeriodEnd } = require('../lib/billingPeriod');

const CURRENCY = 'CLP';
const MIN_AMOUNT_CLP = 950; // MP rechaza montos menores con 400/500

let preApprovalClient = null;

/** Sin exponer el token completo (solo prefijo/sufijo para verificar TEST- vs APP_USR-). */
function mercadoPagoCredentialHints() {
  const at = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
  const pk = process.env.MP_PUBLIC_KEY || '';
  const atHint =
    at.length < 8 ? '(vacío o muy corto)' : `${at.slice(0, 12)}…${at.slice(-4)}`;
  const pkHint =
    pk.length < 8 ? '(vacío o muy corto)' : `${pk.slice(0, 16)}…${pk.slice(-4)}`;
  let mode = 'desconocido';
  if (at.startsWith('TEST-')) mode = 'TEST (credenciales de prueba)';
  else if (at.startsWith('APP_USR-')) mode = 'APP_USR (producción o prueba según panel MP)';
  return { atHint, pkHint, mode, testModeEnv: process.env.MERCADOPAGO_TEST_MODE };
}

/**
 * Identifica el país/sitio de la cuenta ligada al Access Token (MLC = Chile).
 * Si site_id ≠ MLC y usas currency_id CLP, MP suele responder "Cannot operate between different countries".
 */
async function logMercadoPagoSellerContext(accessToken) {
  try {
    const res = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[MercadoPago] GET /users/me falló:', res.status, data?.message || data?.error || '');
      return;
    }
    console.log('[MercadoPago] Cuenta del Access Token (GET /users/me):', {
      user_id: data.id,
      site_id: data.site_id,
      country_id: data.country_id,
      nickname: data.nickname,
    });
    const sid = String(data.site_id || '').toUpperCase();
    if (sid && sid !== 'MLC') {
      console.warn(
        '[MercadoPago] Esta cuenta es de otro sitio MP (site_id',
        data.site_id,
        '). Para suscripciones en CLP necesitas credenciales de aplicación creada en mercadopago.cl (site_id MLC).',
      );
    }
  } catch (e) {
    console.warn('[MercadoPago] No se pudo llamar GET /users/me:', e?.message ?? e);
  }
}

/**
 * Resuelve el payer_email para el preapproval.
 *
 * Regla:
 * - Si MP_TEST_PAYER_EMAIL está definido → siempre úsalo como payer (cubre tanto
 *   tokens TEST- como APP_USR- de cuentas de prueba).
 * - Si no → usa el email del usuario logueado (producción con cuenta real).
 *
 * Contexto: el panel de MP dice que las cuentas de prueba deben usar sus
 * "credenciales de producción" (APP_USR-), no las TEST-. Por eso la condición
 * ya no puede basarse solo en el prefijo del token.
 */
function resolvePayerEmailForPreapproval(loginEmail) {
  const fromLogin = (loginEmail || '').trim();
  const testBuyer = (process.env.MP_TEST_PAYER_EMAIL || '').trim();

  if (testBuyer.length > 0) {
    if (fromLogin && fromLogin.toLowerCase() !== testBuyer.toLowerCase()) {
      console.log('[MercadoPago] payer_email reemplazado por MP_TEST_PAYER_EMAIL (comprador de prueba):', {
        email_login: fromLogin,
        payer_email_enviado_a_MP: testBuyer,
      });
    }
    return testBuyer;
  }

  if (!fromLogin) {
    console.warn('[MercadoPago] payer_email vacío: MP_TEST_PAYER_EMAIL no está definido y el usuario no tiene email.');
  }

  return fromLogin;
}

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
  return { preApprovalClient };
}

/**
 * Crea preapproval en MP. Redirige al checkout para que el usuario pague.
 *
 * @param {string} organizationId
 * @param {string} ownerId
 * @param {string} payerEmail
 * @param {string} planSKU - plan-basico | plan-profesional | plan-premium
 * @param {string} restaurantId - ID del restaurante, usado para construir el back_url de retorno
 */
async function createSubscription(organizationId, ownerId, payerEmail, planSKU = 'plan-profesional', restaurantId, options = {}) {
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

  // back_url: apunta al endpoint de redirect del backend, que parsea preapproval_id
  // y redirige al frontend en /billing?returnFromCheckout=1&preapprovalId=xxx
  const backendBase = (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  let effectiveBackUrl = restaurantId
    ? `${backendBase}/api/redirect-to-billing/${restaurantId}`
    : `${backendBase}/api/redirect-to-billing`;

  // MercadoPago rechaza localhost URLs para back_url.
  if (effectiveBackUrl.includes('localhost') || effectiveBackUrl.includes('127.0.0.1')) {
    effectiveBackUrl = 'https://www.mercadopago.cl';
  }

  if (!effectiveBackUrl) {
    throw new Error('BACKEND_PUBLIC_URL is not set in .env');
  }

  const externalRef = `${organizationId}|${planSKU}`;

  // Webhooks only: must be the public backend (never the restaurant frontend URL).
  const notificationUrl = `${backendBase}/api/webhooks/mercadopago`;

  // start_date puede ser futuro lejano (reactivar al final del periodo) o inmediato (+2 min).
  // options.startDate permite pasar una fecha explícita; si no se pasa, se usa now+2min.
  const minFuture = new Date(Date.now() + 2 * 60 * 1000);
  const startDate =
    options.startDate && new Date(options.startDate) > minFuture
      ? new Date(options.startDate)
      : minFuture;

  const autoRecurring = {
    frequency: mpFreq.frequency,
    frequency_type: mpFreq.frequency_type,
    transaction_amount: amount,
    currency_id: CURRENCY,
    start_date: startDate.toISOString(),
  };

  const resolvedEmail = resolvePayerEmailForPreapproval(payerEmail);
  // payer_email OBLIGATORIO para la API de preapproval.
  // Con cuenta real + token TEST-: el payer debe ser también una cuenta real
  // o, idealmente, una cuenta test_user del mismo par vendedor/comprador.
  // Correr scripts/create-test-users.js para crear el par correcto.
  const payerEmailForBody = resolvedEmail;

  if (!payerEmailForBody) {
    throw new Error(
      'payer_email es requerido por Mercado Pago. ' +
      'Define MP_TEST_PAYER_EMAIL en .env con el email del comprador de prueba. ' +
      'Crea las cuentas con: node scripts/create-test-users.js',
    );
  }

  const body = {
    reason: `SimpleReserva ${config.name} - ${organization.name}`,
    external_reference: externalRef,
    payer_email: payerEmailForBody,
    status: 'pending',
    auto_recurring: autoRecurring,
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
  };

  const hints = mercadoPagoCredentialHints();
  console.log('[MercadoPago] Credenciales (solo pistas):', {
    accessToken: hints.atHint,
    publicKey: hints.pkHint,
    modo: hints.mode,
    MERCADOPAGO_TEST_MODE: hints.testModeEnv,
  });
  console.log('[MercadoPago] Request (sanitized):', {
    amount,
    frequency: `${mpFreq.frequency} ${mpFreq.frequency_type}`,
    currency_id: CURRENCY,
    payer_email: payerEmailForBody,
    external_reference: externalRef,
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
    start_date: startDate.toISOString(),
  });
  console.log('[MercadoPago] Full notification_url being sent to MP:', notificationUrl);
  console.log('[MercadoPago] Start date for subscription:', startDate.toISOString());
  console.log('[MercadoPago] NOTE: MP will send POST requests to this URL when events occur (payment authorized, subscription status changes, etc.)');

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (accessToken && process.env.MERCADOPAGO_LOG_SELLER !== 'false') {
    await logMercadoPagoSellerContext(accessToken);
  }

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
    if (err?.cause) console.error('[MercadoPago] err.cause:', err.cause);
    const apiErr = errBody?.cause ?? err?.cause;
    if (apiErr && typeof apiErr === 'object') {
      console.error('[MercadoPago] Detalle cause:', JSON.stringify(apiErr, null, 2));
    }

    if (String(msg).includes('different countries') || String(msg).includes('countries')) {
      console.error(
        '[MercadoPago] Diagnóstico "different countries": (1) site_id del vendedor ≠ MLC, o (2) con token TEST- el payer_email',
        'no es el comprador de prueba Chile (define MP_TEST_PAYER_EMAIL = usuario test_user_...@testuser.com del panel).',
        'Checkout Bricks es otro producto; aquí usamos PreApproval/suscripciones.',
      );
    }

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

/** MP devuelve esto si el preapproval ya estaba cancelado (p. ej. tras change-plan al vencer o cancelación previa). */
function isPreapprovalAlreadyCancelledError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /cancelled preapproval|already cancelled|cannot modify/i.test(msg);
}

/**
 * Programa una suscripción futura: crea registro con status='scheduled' y startDate futuro.
 * NO cancela la sub cancelled-in-period existente (sigue dando acceso hasta endDate).
 * Cuando venza el periodo y el job de reconciliación o el webhook detecten el primer pago,
 * se transiciona a 'active'.
 */
async function scheduleOrganizationSubscription(organizationId, preapprovalId, planSKU, scheduledStartDate) {
  // Idempotencia: solo omitir si ya enlazamos este preapproval a una fila "viva".
  // Si la fila anterior quedó cancelled/expired (p. ej. al reemplazar un programado),
  // no debe bloquear crear el nuevo scheduled aunque MP reutilice el mismo id.
  const existing = await prisma.subscription.findFirst({
    where: {
      mercadopagoPreapprovalId: preapprovalId,
      status: { notIn: ['cancelled', 'expired'] },
    },
  });
  if (existing) return;

  const organization = await prisma.restaurantOrganization.findUnique({ where: { id: organizationId } });
  if (!organization) throw new Error(`Organización no encontrada: ${organizationId}`);

  const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
  if (!plan) throw new Error(`Plan no encontrado: ${planSKU}`);

  // Cancelar cualquier scheduled previo para esta org (solo puede haber uno programado).
  // Primero cancelar en Mercado Pago para evitar preapprovals huérfanos que cobren en start_date.
  const previousScheduled = await prisma.subscription.findMany({
    where: { organizationId, status: 'scheduled' },
    select: { id: true, mercadopagoPreapprovalId: true },
  });
  for (const row of previousScheduled) {
    if (row.mercadopagoPreapprovalId && row.mercadopagoPreapprovalId !== preapprovalId) {
      try {
        await cancelSubscription(row.mercadopagoPreapprovalId);
      } catch (err) {
        console.warn(
          '[MercadoPago] scheduleOrganizationSubscription: no se pudo cancelar preapproval previo en MP:',
          row.mercadopagoPreapprovalId,
          err?.message ?? err,
        );
      }
    }
  }

  await prisma.subscription.updateMany({
    where: { organizationId, status: 'scheduled' },
    data: { status: 'cancelled', mercadopagoPreapprovalId: null, isActiveSubscription: false },
  });

  await prisma.subscription.create({
    data: {
      organizationId,
      planId: plan.id,
      status: 'scheduled',
      isActiveSubscription: false,
      startDate: scheduledStartDate,
      mercadopagoPreapprovalId: preapprovalId,
    },
  });

  console.log('[MercadoPago] scheduleOrganizationSubscription:', organizationId, planSKU, 'starts:', scheduledStartDate);
}

/**
 * Opciones desde CheckoutSession (cambio de plan inmediato): al activar el nuevo preapproval, cancelar el anterior en MP.
 * @typedef {{ replaceSubscriptionId?: string|null }} ActivateSubscriptionOptions
 */

/**
 * Lee intención de cambio de plan guardada en la sesión de checkout.
 */
async function getActivateOptionsForPreapproval(organizationId, preapprovalId) {
  const session = await prisma.checkoutSession.findFirst({
    where: { organizationId, mercadopagoPreapprovalId: preapprovalId },
    orderBy: { createdAt: 'desc' },
  });
  return { replaceSubscriptionId: session?.pendingChangeFromSubscriptionId ?? null };
}

async function activateOrganizationSubscription(organizationId, preapprovalId, planSKU = 'plan-profesional', options = {}) {
  const { replaceSubscriptionId } = options;

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

  // Cambio de plan inmediato: cancelar en MP la suscripción que seguía activa hasta autorizar el nuevo cobro.
  if (replaceSubscriptionId) {
    const oldSub = await prisma.subscription.findUnique({
      where: { id: replaceSubscriptionId },
      select: { organizationId: true, mercadopagoPreapprovalId: true },
    });
    if (!oldSub || oldSub.organizationId !== organizationId) {
      throw new Error('Suscripción previa no válida para esta organización');
    }
    if (oldSub.mercadopagoPreapprovalId && oldSub.mercadopagoPreapprovalId !== preapprovalId) {
      try {
        await cancelSubscription(oldSub.mercadopagoPreapprovalId);
      } catch (err) {
        if (isPreapprovalAlreadyCancelledError(err)) {
          console.warn(
            '[MercadoPago] activateOrganizationSubscription: preapproval previo ya cancelado en MP, se continúa:',
            oldSub.mercadopagoPreapprovalId,
          );
        } else {
          console.error('[MercadoPago] activateOrganizationSubscription: no se pudo cancelar sub previa en MP:', err?.message ?? err);
          throw new Error(
            'No se pudo completar el cambio de plan con Mercado Pago. Tu plan anterior sigue activo; intenta nuevamente o contacta soporte.',
          );
        }
      }
    }
  }

  // Cancelar en MP cualquier sub programada que vamos a marcar cancelled localmente (evita cobros duplicados).
  const scheduledToClear = await prisma.subscription.findMany({
    where: { organizationId, status: 'scheduled' },
    select: { mercadopagoPreapprovalId: true },
  });
  for (const row of scheduledToClear) {
    if (row.mercadopagoPreapprovalId && row.mercadopagoPreapprovalId !== preapprovalId) {
      try {
        await cancelSubscription(row.mercadopagoPreapprovalId);
      } catch (err) {
        console.warn(
          '[MercadoPago] activateOrganizationSubscription: no se pudo cancelar scheduled previo en MP:',
          row.mercadopagoPreapprovalId,
          err?.message ?? err,
        );
      }
    }
  }

  const activatedAt = new Date();
  const nextPeriodEnd = computePeriodEnd(activatedAt, plan);

  await prisma.$transaction(async (tx) => {
    // Cancelar suscripciones previas (trial, active, scheduled) para evitar duplicados
    await tx.subscription.updateMany({
      where: { organizationId, status: { in: ['trial', 'active', 'scheduled'] } },
      data: { status: 'cancelled', isActiveSubscription: false },
    });
    await tx.subscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: 'active',
        isActiveSubscription: true,
        mercadopagoPreapprovalId: preapprovalId,
        startDate: activatedAt,
        currentPeriodEnd: nextPeriodEnd,
      },
    });
    await tx.restaurantOrganization.update({
      where: { id: organizationId },
      data: { trialEndsAt: null, planId: plan.id },
    });
  });

  planService.invalidateCache(organizationId);
}

async function deactivateOrganizationSubscription(organizationId) {
  await prisma.subscription.updateMany({
    where: { organizationId },
    data: { status: 'expired', isActiveSubscription: false, endDate: new Date() },
  });
}

/**
 * Pasa a periodo de gracia por fallo de pago. Opcionalmente marca una sub programada (mismo preapproval) para reflejar el estado en DB.
 * @param {string} organizationId
 * @param {{ scheduledPreapprovalId?: string|null }} [options]
 */
async function enterGracePeriod(organizationId, options = {}) {
  const { scheduledPreapprovalId } = options;
  const graceEnd = new Date();
  graceEnd.setDate(graceEnd.getDate() + 7);
  await prisma.subscription.updateMany({
    where: { organizationId, status: 'active' },
    data: { status: 'grace', gracePeriodEndsAt: graceEnd, isActiveSubscription: true },
  });
  if (scheduledPreapprovalId) {
    await prisma.subscription.updateMany({
      where: {
        organizationId,
        status: 'scheduled',
        mercadopagoPreapprovalId: scheduledPreapprovalId,
      },
      data: { status: 'grace', gracePeriodEndsAt: graceEnd, isActiveSubscription: true },
    });
  }

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
 *
 * Si MP reporta authorized pero start_date es futuro → scheduled (no activa aún).
 * Si start_date ya pasó o es inminente → activa de inmediato.
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

  // Verificar si start_date es futuro (> 10 min desde ahora → considerar programado)
  const startDate = mpSub?.auto_recurring?.start_date || mpSub?.start_date || mpSub?.date_created;
  const THRESHOLD_MS = 10 * 60 * 1000;
  const isFutureStart = startDate && (new Date(startDate).getTime() - Date.now() > THRESHOLD_MS);

  if (isFutureStart) {
    await scheduleOrganizationSubscription(organizationId, preapprovalId, planSKU, new Date(startDate));
    console.log('[MercadoPago] confirmSubscriptionFromPreapproval scheduled:', organizationId, planSKU, startDate);
    return { activated: false, scheduled: true, scheduledDate: startDate, planSKU };
  }

  // Consultar la CheckoutSession para saber la intención del usuario (activar ahora vs programar al vencer).
  // Si la sesión existe y NO tiene startDate futura (when=now), activar de inmediato aunque haya una sub cancelled con acceso.
  const checkoutSession = await prisma.checkoutSession.findFirst({
    where: { organizationId, mercadopagoPreapprovalId: preapprovalId },
    orderBy: { createdAt: 'desc' },
  });
  const sessionWantsImmediate = !!checkoutSession?.pendingChangeFromSubscriptionId;

  // Solo desviar a scheduled cuando NO fue intencional "activar ahora":
  // Si hay una sub cancelled con acceso vigente + plan distinto + start_date cercano + NO hay sesión de "cambio inmediato",
  // entonces el checkout fue para cambio al vencer el periodo.
  if (!sessionWantsImmediate) {
    const hasActiveSubscription = await prisma.subscription.findFirst({
      where: { organizationId, status: 'active' },
    });
    const cancelledWithAccess = await prisma.subscription.findFirst({
      where: { organizationId, status: 'cancelled', endDate: { gt: new Date() } },
      orderBy: { startDate: 'desc' },
      include: { plan: true },
    });

    // start_date de MP está dentro de ±2 días del endDate de la sub cancelada → intención "al vencer"
    const mpStartMs = startDate ? new Date(startDate).getTime() : 0;
    const cancelEndMs = cancelledWithAccess?.endDate ? cancelledWithAccess.endDate.getTime() : 0;
    const startNearPeriodEnd = cancelEndMs > 0 && mpStartMs > 0 && Math.abs(mpStartMs - cancelEndMs) < 48 * 60 * 60 * 1000;

    const planChangeAtPeriodEnd =
      !hasActiveSubscription &&
      cancelledWithAccess?.plan?.productSKU &&
      cancelledWithAccess.plan.productSKU !== planSKU &&
      startNearPeriodEnd;

    if (planChangeAtPeriodEnd) {
      const rawStart =
        mpSub?.auto_recurring?.start_date ||
        mpSub?.start_date ||
        (cancelledWithAccess.endDate ? cancelledWithAccess.endDate.toISOString() : null) ||
        mpSub?.date_created;
      const sd = new Date(rawStart);
      await scheduleOrganizationSubscription(organizationId, preapprovalId, planSKU, sd);
      console.log(
        '[MercadoPago] confirmSubscriptionFromPreapproval scheduled (cambio al vencer periodo):',
        organizationId,
        planSKU,
        rawStart,
      );
      return {
        activated: false,
        scheduled: true,
        scheduledDate: rawStart,
        planSKU,
      };
    }
  }

  const activateOpts = await getActivateOptionsForPreapproval(organizationId, preapprovalId);
  await activateOrganizationSubscription(organizationId, preapprovalId, planSKU, activateOpts);
  console.log('[MercadoPago] confirmSubscriptionFromPreapproval activated:', organizationId, planSKU);
  return { activated: true };
}

module.exports = {
  createSubscription,
  cancelSubscription,
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  deactivateOrganizationSubscription,
  enterGracePeriod,
  confirmSubscriptionFromPreapproval,
  getActivateOptionsForPreapproval,
};
