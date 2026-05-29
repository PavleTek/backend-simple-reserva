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
const {
  getMercadoPagoAccessToken,
  getMercadoPagoPublicKey,
  describeMercadoPagoCredentialChoice,
} = require('../lib/mercadopagoEnv');

const CURRENCY = 'CLP';
const MIN_AMOUNT_CLP = 950; // MP rechaza montos menores con 400/500
const IVA_RATE = 0.19; // IVA Chile

let preApprovalClient = null;
/** Evita reutilizar cliente de MP si cambia el access token resuelto por entorno. */
let cachedMercadoPagoAccessToken = null;

/** Sin exponer el token completo (solo prefijo/sufijo para verificar TEST- vs APP_USR-). */
function mercadoPagoCredentialHints() {
  const at = getMercadoPagoAccessToken();
  const pk = getMercadoPagoPublicKey();
  const atHint =
    at.length < 8 ? '(vacío o muy corto)' : `${at.slice(0, 12)}…${at.slice(-4)}`;
  const pkHint =
    pk.length < 8 ? '(vacío o muy corto)' : `${pk.slice(0, 16)}…${pk.slice(-4)}`;
  let mode = 'desconocido';
  if (at.startsWith('TEST-')) mode = 'TEST (credenciales de prueba)';
  else if (at.startsWith('APP_USR-')) mode = 'APP_USR (producción o prueba según panel MP)';
  return {
    atHint,
    pkHint,
    mode,
    testModeEnv: process.env.MERCADOPAGO_TEST_MODE,
    credentialChoice: describeMercadoPagoCredentialChoice(),
  };
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

function isMercadoPagoDifferentCountriesError(err, errBody = null) {
  const msg = String(errBody?.message ?? err?.message ?? '');
  return msg.includes('different countries') || /cannot operate between.*countr/i.test(msg);
}

/** Texto para el front antes de redirigir a init_point (es-CL). */
function getMercadoPagoCheckoutHints(mercadopagoPayerEmail) {
  const emailHint = mercadopagoPayerEmail
    ? `En Mercado Pago debes usar el correo: ${mercadopagoPayerEmail}`
    : 'En Mercado Pago usa el mismo correo que confirmaste aquí.';
  return {
    title: 'Pago en Mercado Pago Chile',
    lines: [
      emailHint,
      'El pago es en mercadopago.cl (pesos chilenos, CLP).',
      'Puedes pagar con tarjeta o con una cuenta Mercado Pago creada en Chile.',
      'Si ese correo está solo en Mercado Pago de otro país, elige otro correo con cuenta en mercadopago.cl.',
    ],
  };
}

/**
 * Resuelve el payer_email para el preapproval (debe coincidir en el checkout MP — doc oficial).
 *
 * Prioridad: MP_TEST_PAYER_EMAIL → billingEmail de la org → email del owner/login.
 */
/** Error 403 PolicyAgent: token OK pero producto Suscripciones no habilitado en la aplicación MP. */
function isMercadoPagoPolicyBlockedError(err, errBody = null, status = null) {
  const body = errBody ?? (typeof err === 'object' && err !== null ? err : {});
  const code = body?.code ?? body?.cause?.[0]?.code;
  const blockedBy = body?.blocked_by ?? body?.cause?.[0]?.blocked_by;
  const msg = String(body?.message ?? err?.message ?? '');
  const st = status ?? body?.status ?? body?.statusCode;
  return (
    st === 403 &&
    (code === 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES' ||
      blockedBy === 'PolicyAgent' ||
      msg.includes('UNAUTHORIZED') ||
      msg.includes('PolicyAgent'))
  );
}

function resolvePayerEmailForPreapproval(loginEmail, billingEmailFromOrg) {
  const fromLogin = (loginEmail || '').trim().toLowerCase();
  const fromBilling = (billingEmailFromOrg || '').trim().toLowerCase();
  const testBuyer = (process.env.MP_TEST_PAYER_EMAIL || '').trim();

  if (testBuyer.length > 0) {
    if (fromLogin && fromLogin !== testBuyer.toLowerCase()) {
      console.log('[MercadoPago] payer_email reemplazado por MP_TEST_PAYER_EMAIL (comprador de prueba):', {
        email_login: fromLogin,
        payer_email_enviado_a_MP: testBuyer,
      });
    }
    return testBuyer;
  }

  if (fromBilling) {
    console.log('[MercadoPago] payer_email desde billingEmail de la organización:', {
      email_login: fromLogin || '(sin email login)',
      payer_email_enviado_a_MP: fromBilling,
    });
    return fromBilling;
  }

  if (fromLogin) {
    console.log('[MercadoPago] payer_email desde email del owner (sin billingEmail guardado):', {
      payer_email_enviado_a_MP: fromLogin,
    });
    return fromLogin;
  }

  return '';
}

function getClient() {
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
  }
  if (!preApprovalClient || cachedMercadoPagoAccessToken !== accessToken) {
    const { MercadoPagoConfig, PreApproval } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });
    preApprovalClient = new PreApproval(client);
    cachedMercadoPagoAccessToken = accessToken;
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
    select: { name: true, billingEmail: true },
  });
  if (!organization) throw new Error('Organización no encontrada');

  const config = await planService.getPlanConfig(planSKU);
  if (!config) throw new Error(`Plan no encontrado: ${planSKU}`);

  const planAmount = Number(config.priceCLP);
  const mpFreq = planService.toMercadoPagoFrequency(config.billingFrequency, config.billingFrequencyType);
  // priceCLP es precio neto (sin IVA); el frontend lo muestra como "más IVA (19%)".
  let amount = Math.round(planAmount * (1 + IVA_RATE));
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

  // MP: start_date solo es válido si también envías end_date (docs Suscripciones).
  const endDate = new Date(startDate);
  endDate.setFullYear(endDate.getFullYear() + 10);

  const autoRecurring = {
    frequency: mpFreq.frequency,
    frequency_type: mpFreq.frequency_type,
    transaction_amount: amount,
    currency_id: CURRENCY,
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
  };

  const payerEmailForBody = resolvePayerEmailForPreapproval(payerEmail, organization.billingEmail);

  if (!payerEmailForBody) {
    throw new Error(
      'Indica el correo de tu cuenta Mercado Pago Chile. ' +
      'En desarrollo puedes definir MP_TEST_PAYER_EMAIL en .env (comprador de prueba).',
    );
  }

  const buildBody = (email) => ({
    reason: `SimpleReserva ${config.name} - ${organization.name}`,
    external_reference: externalRef,
    payer_email: email,
    status: 'pending',
    auto_recurring: autoRecurring,
    back_url: effectiveBackUrl,
    notification_url: notificationUrl,
  });

  const hints = mercadoPagoCredentialHints();
  console.log('[MercadoPago] Credenciales (solo pistas):', {
    accessToken: hints.atHint,
    publicKey: hints.pkHint,
    modo: hints.mode,
    MERCADOPAGO_TEST_MODE: hints.testModeEnv,
    entorno_credenciales: hints.credentialChoice?.source,
    token_desde: hints.credentialChoice?.accessTokenEnvKey,
    public_key_desde: hints.credentialChoice?.publicKeyEnvKey,
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
    end_date: endDate.toISOString(),
  });
  console.log('[MercadoPago] Full notification_url being sent to MP:', notificationUrl);
  console.log('[MercadoPago] Start date for subscription:', startDate.toISOString());
  console.log('[MercadoPago] NOTE: MP will send POST requests to this URL when events occur (payment authorized, subscription status changes, etc.)');

  const accessToken = getMercadoPagoAccessToken();
  if (accessToken && process.env.MERCADOPAGO_LOG_SELLER !== 'false') {
    await logMercadoPagoSellerContext(accessToken);
  }

  const { preApprovalClient } = getClient();
  let body = buildBody(payerEmailForBody);

  const tryCreate = async (requestBody) => preApprovalClient.create({ body: requestBody });

  try {
    return await tryCreate(body);
  } catch (err) {
    const finalBody = typeof err === 'object' && err !== null ? err : {};
    const finalMsg = finalBody?.message ?? err?.error ?? err?.message ?? 'Error MercadoPago';
    const finalStatus = finalBody?.status ?? finalBody?.statusCode;

    console.error('[MercadoPago]', finalMsg);
    console.error('[MercadoPago] Response:', JSON.stringify(finalBody, null, 2));
    if (err?.cause) console.error('[MercadoPago] err.cause:', err.cause);
    const apiErr = finalBody?.cause ?? err?.cause;
    if (apiErr && typeof apiErr === 'object') {
      console.error('[MercadoPago] Detalle cause:', JSON.stringify(apiErr, null, 2));
    }

    if (isMercadoPagoDifferentCountriesError(err, finalBody)) {
      console.error(
        '[MercadoPago] Diagnóstico "different countries":',
        payerEmailForBody,
        'está en Mercado Pago de otro país. El vendedor es Chile (MLC). Usa un correo con cuenta en mercadopago.cl.',
      );
    }

    const policyBlocked = isMercadoPagoPolicyBlockedError(err, finalBody, finalStatus);
    if (policyBlocked) {
      console.error(
        '[MercadoPago] Diagnóstico PolicyAgent (403): el Access Token es válido pero la app/cuenta no tiene permiso para Suscripciones.',
        'Revisa en https://www.mercadopago.cl/developers/panel/app que el producto "Suscripciones" esté activo',
        'y usa el Access Token de Producción de ESA aplicación (no solo credenciales genéricas de Tu negocio).',
        'Si ya está activo, abre ticket en Soporte MP con este body y hora exacta.',
      );
    }

    let userMsg = finalMsg;
    const payerCountryMismatch = isMercadoPagoDifferentCountriesError(err, finalBody);
    if (policyBlocked) {
      userMsg = 'Mercado Pago no autorizó crear la suscripción (configuración de cuenta). Contacta a soporte.';
    } else if (payerCountryMismatch) {
      userMsg =
        `El correo ${payerEmailForBody} está asociado a Mercado Pago de otro país. ` +
        'Indica otro correo con cuenta en mercadopago.cl (Chile) e intenta de nuevo.';
    } else if (finalStatus === 500 || String(finalMsg).toLowerCase().includes('internal')) {
      userMsg = 'MercadoPago no disponible. Verifica MERCADOPAGO_ACCESS_TOKEN.';
    }

    const e = new Error(userMsg);
    e.cause = err;
    e.mpPolicyBlocked = policyBlocked;
    e.mpPayerCountryMismatch = payerCountryMismatch;
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
 * Al programar una suscripción futura (end_of_period), cancela el preapproval anterior en MP
 * para evitar doble cobro cuando el nuevo plan entre en vigencia.
 * Busca el pendingChangeFromSubscriptionId en la CheckoutSession del nuevo preapproval.
 * No lanza error si no hay nada que cancelar o si ya estaba cancelado.
 */
async function cancelReplacedPreapprovalOnSchedule(organizationId, newPreapprovalId) {
  const session = await prisma.checkoutSession.findFirst({
    where: { organizationId, mercadopagoPreapprovalId: newPreapprovalId },
    orderBy: { createdAt: 'desc' },
    select: { pendingChangeFromSubscriptionId: true },
  });
  if (!session?.pendingChangeFromSubscriptionId) return;

  const oldSub = await prisma.subscription.findUnique({
    where: { id: session.pendingChangeFromSubscriptionId },
    select: { mercadopagoPreapprovalId: true, organizationId: true },
  });
  if (!oldSub || oldSub.organizationId !== organizationId) return;
  if (!oldSub.mercadopagoPreapprovalId || oldSub.mercadopagoPreapprovalId === newPreapprovalId) return;

  try {
    await cancelSubscription(oldSub.mercadopagoPreapprovalId);
    console.log('[MercadoPago] cancelReplacedPreapprovalOnSchedule: cancelado preapproval anterior en MP:', oldSub.mercadopagoPreapprovalId);
  } catch (err) {
    if (!isPreapprovalAlreadyCancelledError(err)) {
      console.warn('[MercadoPago] cancelReplacedPreapprovalOnSchedule: no se pudo cancelar preapproval anterior:', oldSub.mercadopagoPreapprovalId, err?.message ?? err);
    }
  }
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
  const {
    replaceSubscriptionId,
    paymentProvider = 'mercadopago_preapproval',
    providerCheckoutSessionId = null,
  } = options;

  if (preapprovalId) {
    const existing = await prisma.subscription.findFirst({
      where: { mercadopagoPreapprovalId: preapprovalId, status: 'active' },
    });
    if (existing) return;
  }

  if (paymentProvider === 'mp_checkout_pro' && providerCheckoutSessionId) {
    const existingCp = await prisma.subscription.findFirst({
      where: {
        organizationId,
        paymentProvider: 'mp_checkout_pro',
        providerCheckoutSessionId,
        status: 'active',
      },
    });
    if (existingCp) return;
  }

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
    // Cancelar suscripciones previas para evitar duplicados.
    // Incluye 'grace': cuando el cliente compra un plan nuevo durante periodo de gracia,
    // la sub en grace queda reemplazada por la nueva activa.
    await tx.subscription.updateMany({
      where: { organizationId, status: { in: ['trial', 'active', 'scheduled', 'grace'] } },
      data: { status: 'cancelled', isActiveSubscription: false },
    });
    await tx.subscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: 'active',
        isActiveSubscription: true,
        mercadopagoPreapprovalId: preapprovalId || null,
        paymentProvider,
        providerCheckoutSessionId: providerCheckoutSessionId || null,
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

  try {
    const referralService = require('./referralService');
    const activeSub = await prisma.subscription.findFirst({
      where: { organizationId, mercadopagoPreapprovalId: preapprovalId, status: 'active' },
      select: { id: true },
    });
    if (activeSub) {
      await referralService.markCreditsApplied(organizationId, activeSub.id, preapprovalId);
    }
    await referralService.markFirstPayment(organizationId);
  } catch (refErr) {
    console.warn('[MercadoPago] activateOrganizationSubscription referral hooks failed:', refErr?.message ?? refErr);
  }
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
      const { billingUrl } = require('../utils/restaurantPanelUrl');
      const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;
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
    await cancelReplacedPreapprovalOnSchedule(organizationId, preapprovalId);
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
      await cancelReplacedPreapprovalOnSchedule(organizationId, preapprovalId);
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
  getMercadoPagoCheckoutHints,
  isMercadoPagoPolicyBlockedError,
  createSubscription,
  cancelSubscription,
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  cancelReplacedPreapprovalOnSchedule,
  deactivateOrganizationSubscription,
  enterGracePeriod,
  confirmSubscriptionFromPreapproval,
  getActivateOptionsForPreapproval,
};
