/**
 * Flow.cl subscription billing for SimpleReserva.
 *
 * Model:
 * - One Flow plan per (SKU, gross amount, interval). planId = env prefix + hash.
 * - Checkout = card enrollment (customer/register). Card is required.
 * - Recurring invoices are generated and charged by Flow.
 * - Plan change = cancel previous Flow subscription + create a new one.
 *
 * Shared Flow account with SimpleHora: prefixes must not collide (sr vs sh).
 */

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { montoEfectivoNeto } = require('../lib/addonPricing');
const { describeFlowCredentialChoice } = require('../lib/flowEnv');
const { flowGet, flowPost, FlowApiError } = require('../lib/flowClient');
const { checkoutSessionBillingData, PAYMENT_PROVIDER_FLOW } = require('../lib/billingDomain');

const CURRENCY = 'CLP';
const MIN_AMOUNT_CLP = 950;
const IVA_RATE = 0.19;
const EXTERNAL_ID_PREFIX = 'sreserva';
const FLOW_INTERVAL_DAILY = 1;
const FLOW_INTERVAL_WEEKLY = 2;
const FLOW_INTERVAL_MONTHLY = 3;
const FLOW_INTERVAL_YEARLY = 4;
const FLOW_SUB_STATUS_ACTIVE = 1;

function grossAmountFromNet(planAmount) {
  let amount = Math.round(Number(planAmount) * (1 + IVA_RATE));
  if (amount < MIN_AMOUNT_CLP) amount = MIN_AMOUNT_CLP;
  return amount;
}

function resolveFlowInterval(plan) {
  const count = Math.max(1, Number(plan?.billingFrequency) || 1);
  const type = String(plan?.billingFrequencyType || 'months');
  if (type === 'days') return { interval: FLOW_INTERVAL_DAILY, intervalCount: count };
  if (type === 'weeks') return { interval: FLOW_INTERVAL_WEEKLY, intervalCount: count };
  if (type === 'yearly') return { interval: FLOW_INTERVAL_YEARLY, intervalCount: count };
  return { interval: FLOW_INTERVAL_MONTHLY, intervalCount: count };
}

function buildFlowPlanId({ productSKU, grossAmount, interval, intervalCount }) {
  const prefix = 'sr';
  const sku = String(productSKU || '').trim();
  if (!sku) throw new Error('Plan sin productSKU, no se puede crear en Flow');
  const payload = `${sku}|${Number(grossAmount)}|${Number(interval)}|${Number(intervalCount)}`;
  const hash = crypto.createHash('sha256').update(payload).digest().subarray(0, 10).toString('hex');
  return `${prefix}${hash}`;
}

function buildCustomerExternalId(organizationId) {
  return `${EXTERNAL_ID_PREFIX}|${organizationId}`;
}

function formatFlowDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getBackendPublicUrl() {
  return (process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function hasEnrolledCard(org) {
  return Boolean(org?.flowCardRegisteredAt || org?.flowCardLast4);
}

function isRegisterSuccess(status) {
  return status === 1 || status === '1';
}

function isFlowPaymentPaid(status) {
  return Number(status) === 2;
}

function isFlowPaymentRejected(status) {
  const n = Number(status);
  return n === 3 || n === 4;
}

function isFlowSubscriptionActive(status) {
  return Number(status) === FLOW_SUB_STATUS_ACTIVE;
}

function isAlreadyExistsError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return /already|existe|exist|duplic/i.test(msg);
}

async function computeFlowGrossAmount(organizationId, plan) {
  const efectivoNeto = await montoEfectivoNeto(organizationId, plan.priceCLP);
  return grossAmountFromNet(efectivoNeto);
}

async function ensureFlowCustomer(organizationId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      flowCustomerId: true,
      flowCardLast4: true,
      flowCardBrand: true,
      flowCardRegisteredAt: true,
      owner: { select: { email: true, name: true, lastName: true } },
    },
  });
  if (!org) throw new Error('Organización no encontrada');
  if (org.flowCustomerId) {
    try {
      const remote = await flowGet('/customer/get', { customerId: org.flowCustomerId });
      return { org, customer: remote, created: false };
    } catch (err) {
      console.warn('[Flow] customer/get failed, will recreate:', err?.message);
    }
  }

  const name = [org.owner?.name, org.owner?.lastName].filter(Boolean).join(' ').trim() || org.name;
  const email = (org.owner?.email || '').trim();
  if (!email) throw new Error('El dueño de la organización no tiene email para crear el cliente Flow.');

  const externalId = buildCustomerExternalId(organizationId);
  let customer;
  try {
    customer = await flowPost('/customer/create', { name, email, externalId });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    console.warn('[Flow] customer/create already exists, listing by email/name');
    const listed = await flowGet('/customer/list', { filter: email, start: 0, limit: 20 }).catch(() => null);
    const rows = Array.isArray(listed?.data) ? listed.data : [];
    customer = rows.find((row) => row.externalId === externalId || row.email === email) || null;
    if (!customer) throw err;
  }

  const customerId = customer.customerId;
  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: {
      flowCustomerId: customerId,
      flowCardBrand: customer.creditCardType || undefined,
      flowCardLast4: customer.last4CardDigits || undefined,
      flowCardRegisteredAt: customer.registerDate ? new Date(customer.registerDate) : undefined,
    },
  });

  return { org: { ...org, flowCustomerId: customerId }, customer, created: true };
}

async function persistCardFromCustomer(organizationId, customer) {
  if (!customer) return;
  const last4 = customer.last4CardDigits != null && customer.last4CardDigits !== ''
    ? String(customer.last4CardDigits)
    : null;
  const brand = customer.creditCardType || null;
  const registeredAt = customer.registerDate ? new Date(customer.registerDate) : new Date();
  if (!last4 && !brand) return;
  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: {
      flowCardBrand: brand,
      flowCardLast4: last4,
      flowCardRegisteredAt: registeredAt,
    },
  });
}

async function persistCardFromRegisterStatus(organizationId, statusPayload) {
  const last4 = statusPayload?.last4CardDigits ? String(statusPayload.last4CardDigits) : null;
  const brand = statusPayload?.creditCardType || null;
  if (!last4 && !brand) return;
  await prisma.restaurantOrganization.update({
    where: { id: organizationId },
    data: {
      flowCardBrand: brand,
      flowCardLast4: last4,
      flowCardRegisteredAt: new Date(),
      ...(statusPayload.customerId ? { flowCustomerId: statusPayload.customerId } : {}),
    },
  });
}

async function ensureFlowPlan(plan, grossAmount) {
  const { interval, intervalCount } = resolveFlowInterval(plan);
  const flowPlanId = buildFlowPlanId({
    productSKU: plan.productSKU,
    grossAmount,
    interval,
    intervalCount,
  });

  try {
    await flowGet('/plans/get', { planId: flowPlanId });
    return flowPlanId;
  } catch (err) {
    console.warn('[Flow] plans/get missed, will create:', flowPlanId, err?.message);
  }

  const backendBase = getBackendPublicUrl();
  const params = {
    planId: flowPlanId,
    name: `SimpleReserva ${plan.name || plan.productSKU}`.slice(0, 45),
    currency: CURRENCY,
    amount: grossAmount,
    interval,
    interval_count: intervalCount,
    days_until_due: 3,
    charges_retries_number: 3,
    urlCallback: `${backendBase}/api/webhooks/flow`,
  };

  try {
    await flowPost('/plans/create', params);
  } catch (err) {
    if (!isAlreadyExistsError(err)) {
      console.error('[Flow] plans/create failed:', {
        flowPlanId,
        amount: grossAmount,
        status: err?.status,
        code: err?.code,
        message: err?.message,
        payload: err?.payload,
      });
      throw err;
    }
    await flowGet('/plans/get', { planId: flowPlanId });
  }

  return flowPlanId;
}

function buildCheckoutUrl(registerResponse) {
  const url = registerResponse?.url || '';
  const token = registerResponse?.token || '';
  if (!url || !token) throw new Error('Flow no devolvió url/token de registro de tarjeta');
  return { checkoutUrl: `${url}?token=${token}`, token };
}

async function createCardRegistration(customerId, restaurantId) {
  const backendBase = getBackendPublicUrl();
  const suffix = restaurantId ? `/${encodeURIComponent(restaurantId)}` : '';
  const register = await flowPost('/customer/register', {
    customerId,
    url_return: `${backendBase}/api/billing/flow/register-return${suffix}`,
  });
  return buildCheckoutUrl(register);
}

async function cancelFlowSubscription(flowSubscriptionId, atPeriodEnd = 0) {
  if (!flowSubscriptionId) return;
  try {
    await flowPost('/subscription/cancel', {
      subscriptionId: flowSubscriptionId,
      at_period_end: atPeriodEnd ? 1 : 0,
    });
  } catch (err) {
    const msg = String(err?.message || '');
    if (/already|cancelad|not found|no exist/i.test(msg)) {
      console.warn('[Flow] cancel already terminal:', msg);
      return;
    }
    throw err;
  }
}

async function createFlowSubscription({ customerId, flowPlanId, trialPeriodDays, subscriptionStart }) {
  const params = {
    planId: flowPlanId,
    customerId,
  };
  if (trialPeriodDays > 0) params.trial_period_days = trialPeriodDays;
  if (subscriptionStart) params.subscription_start = formatFlowDate(subscriptionStart);
  return flowPost('/subscription/create', params);
}

async function getFlowSubscription(subscriptionId) {
  return flowGet('/subscription/get', { subscriptionId });
}

async function getRegisterStatus(token) {
  return flowGet('/customer/getRegisterStatus', { token });
}

async function getPaymentStatus(token) {
  return flowGet('/payment/getStatus', { token });
}

function daysUntil(date) {
  if (!date) return 0;
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function resolveTrialDays({ when, trialEndsAt, periodEnd }) {
  if (when === 'end_of_trial') return daysUntil(trialEndsAt);
  if (when === 'end_of_period') return daysUntil(periodEnd);
  return 0;
}

async function createCheckoutSession({
  organizationId,
  userId,
  planId,
  pendingChangeFromSubscriptionId,
  scheduledStartAt,
}) {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);
  const billingFields = checkoutSessionBillingData({
    billingStrategy: 'automatic_recurring',
    paymentProvider: PAYMENT_PROVIDER_FLOW,
  });
  return prisma.checkoutSession.create({
    data: {
      organizationId,
      userId,
      planId,
      status: 'pending',
      expiresAt,
      paymentProvider: billingFields.paymentProvider,
      billingStrategy: billingFields.billingStrategy,
      providerImplementation: billingFields.providerImplementation,
      pendingChangeFromSubscriptionId: pendingChangeFromSubscriptionId || null,
      scheduledStartAt: scheduledStartAt ? new Date(scheduledStartAt) : null,
    },
  });
}

async function startCardEnrollmentCheckout({
  organizationId,
  userId,
  plan,
  restaurantId,
  pendingChangeFromSubscriptionId,
  scheduledStartAt,
}) {
  const hints = describeFlowCredentialChoice();
  console.log('[Flow] Credenciales:', { entorno: hints.source, baseUrl: hints.baseUrl });

  const { org, customer } = await ensureFlowCustomer(organizationId);
  if (hasEnrolledCard(org) || customer?.last4CardDigits) {
    return null;
  }

  const amount = await computeFlowGrossAmount(organizationId, plan);
  await ensureFlowPlan(plan, amount);
  const session = await createCheckoutSession({
    organizationId,
    userId,
    planId: plan.id,
    pendingChangeFromSubscriptionId,
    scheduledStartAt,
  });

  const { checkoutUrl, token } = await createCardRegistration(
    org.flowCustomerId || customer.customerId,
    restaurantId,
  );
  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { checkoutUrl, flowRegisterToken: token },
  });
  return { checkoutUrl, sessionId: session.id };
}

async function applyLocalSubscription({
  organizationId,
  plan,
  flowSubscriptionId,
  flowPlanId,
  when,
  periodEnd,
  pendingChangeFromSubscriptionId,
  referralFreeUntil,
}) {
  const mercadopagoService = require('./mercadopagoService');
  const extras = {
    flowSubscriptionId,
    flowPlanId,
    paymentProviderPsp: PAYMENT_PROVIDER_FLOW,
    replaceSubscriptionId: pendingChangeFromSubscriptionId || null,
    referralFreeUntil: referralFreeUntil || null,
  };

  if (when === 'end_of_trial' || when === 'end_of_period') {
    const start = when === 'end_of_trial' ? periodEnd : periodEnd;
    await mercadopagoService.scheduleOrganizationSubscription(
      organizationId,
      null,
      plan.productSKU,
      start ? new Date(start) : new Date(),
      extras,
    );
    return { activated: false, scheduled: true, scheduledDate: start };
  }

  await mercadopagoService.activateOrganizationSubscription(
    organizationId,
    null,
    plan.productSKU,
    extras,
  );
  return { activated: true, scheduled: false };
}

async function subscribeWithEnrolledCard({
  organizationId,
  userId,
  plan,
  restaurantId,
  pendingChangeFromSubscriptionId,
  when = 'now',
  trialEndsAt,
  periodEnd,
  referralFreeUntil,
}) {
  const { customer } = await ensureFlowCustomer(organizationId);
  const customerId = customer.customerId;
  if (!customer.last4CardDigits && !customer.creditCardType) {
    throw new Error('Debes registrar una tarjeta en Flow antes de activar el plan.');
  }
  await persistCardFromCustomer(organizationId, customer);

  const amount = await computeFlowGrossAmount(organizationId, plan);
  const flowPlanId = await ensureFlowPlan(plan, amount);
  const session = await createCheckoutSession({
    organizationId,
    userId,
    planId: plan.id,
    pendingChangeFromSubscriptionId,
    scheduledStartAt: when === 'end_of_trial' ? trialEndsAt : (when === 'end_of_period' ? periodEnd : null),
  });

  const trialPeriodDays = resolveTrialDays({ when, trialEndsAt, periodEnd });
  const subscriptionStart = when === 'end_of_period' && periodEnd ? periodEnd : null;

  if (pendingChangeFromSubscriptionId && when === 'now') {
    const oldSub = await prisma.subscription.findUnique({
      where: { id: pendingChangeFromSubscriptionId },
      select: { flowSubscriptionId: true, mercadopagoPreapprovalId: true, organizationId: true },
    });
    if (oldSub?.organizationId === organizationId) {
      if (oldSub.flowSubscriptionId) {
        await cancelFlowSubscription(oldSub.flowSubscriptionId, 0);
      }
    }
  }

  const created = await createFlowSubscription({
    customerId,
    flowPlanId,
    trialPeriodDays,
    subscriptionStart,
  });
  const flowSubscriptionId = created.subscriptionId;
  if (!flowSubscriptionId) throw new Error('Flow no devolvió subscriptionId');

  const result = await applyLocalSubscription({
    organizationId,
    plan,
    flowSubscriptionId,
    flowPlanId,
    when,
    periodEnd: when === 'end_of_trial' ? trialEndsAt : periodEnd,
    pendingChangeFromSubscriptionId,
    referralFreeUntil,
  });

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: 'completed', completedAt: new Date() },
  });

  return { ...result, providerId: PAYMENT_PROVIDER_FLOW, restaurantId };
}

async function resultFromExistingSession(organizationId, session) {
  const existing = await prisma.subscription.findFirst({
    where: {
      organizationId,
      planId: session.planId,
      status: { in: ['active', 'scheduled'] },
    },
    orderBy: { startDate: 'desc' },
  });
  if (existing?.status === 'active') return { activated: true, scheduled: false, providerId: PAYMENT_PROVIDER_FLOW };
  if (existing?.status === 'scheduled') {
    return {
      activated: false,
      scheduled: true,
      scheduledDate: existing.startDate,
      providerId: PAYMENT_PROVIDER_FLOW,
    };
  }
  return { activated: false, reason: 'El registro de tarjeta ya fue procesado', providerId: PAYMENT_PROVIDER_FLOW };
}

async function confirmFromRegisterToken(organizationId, token) {
  if (!token) throw new Error('flowToken requerido');

  let statusPayload;
  try {
    statusPayload = await getRegisterStatus(token);
  } catch (err) {
    throw new Error('No se pudo verificar el registro de tarjeta con Flow');
  }

  if (!isRegisterSuccess(statusPayload?.status)) {
    return { activated: false, reason: 'El registro de tarjeta no fue completado' };
  }

  await persistCardFromRegisterStatus(organizationId, statusPayload);

  const session = await prisma.checkoutSession.findFirst({
    where: { organizationId, flowRegisterToken: token, paymentProvider: PAYMENT_PROVIDER_FLOW },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });
  if (!session) {
    return { activated: false, reason: 'No hay una sesión de checkout pendiente para este registro' };
  }
  if (session.status === 'completed') {
    return resultFromExistingSession(organizationId, session);
  }

  const claimed = await prisma.checkoutSession.updateMany({
    where: { id: session.id, status: { in: ['pending', 'expired'] } },
    data: { status: 'processing' },
  });
  if (claimed.count === 0) {
    return resultFromExistingSession(organizationId, session);
  }

  const { customer } = await ensureFlowCustomer(organizationId);
  const amount = await computeFlowGrossAmount(organizationId, session.plan);
  const flowPlanId = await ensureFlowPlan(session.plan, amount);

  let when = 'now';
  if (session.scheduledStartAt && new Date(session.scheduledStartAt) > new Date()) {
    when = 'end_of_period';
  }

  const trialPeriodDays = resolveTrialDays({
    when,
    trialEndsAt: null,
    periodEnd: session.scheduledStartAt,
  });

  if (session.pendingChangeFromSubscriptionId) {
    const oldSub = await prisma.subscription.findUnique({
      where: { id: session.pendingChangeFromSubscriptionId },
      select: { flowSubscriptionId: true, organizationId: true },
    });
    if (oldSub?.flowSubscriptionId && oldSub.organizationId === organizationId) {
      await cancelFlowSubscription(oldSub.flowSubscriptionId, 0);
    }
  }

  let created;
  try {
    created = await createFlowSubscription({
      customerId: customer.customerId,
      flowPlanId,
      trialPeriodDays,
      subscriptionStart: when === 'end_of_period' && session.scheduledStartAt ? session.scheduledStartAt : null,
    });
  } catch (err) {
    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status: 'pending' },
    }).catch(() => {});
    throw err;
  }
  const flowSubscriptionId = created.subscriptionId;
  if (!flowSubscriptionId) throw new Error('Flow no devolvió subscriptionId');

  try {
    const result = await applyLocalSubscription({
      organizationId,
      plan: session.plan,
      flowSubscriptionId,
      flowPlanId,
      when,
      periodEnd: session.scheduledStartAt,
      pendingChangeFromSubscriptionId: session.pendingChangeFromSubscriptionId,
    });

    await prisma.checkoutSession.updateMany({
      where: { id: session.id },
      data: { status: 'completed', completedAt: new Date() },
    });
    return { ...result, providerId: PAYMENT_PROVIDER_FLOW };
  } catch (err) {
    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status: 'pending' },
    }).catch(() => {});
    throw err;
  }
}

async function resolveOrgFromFlowPayment(payment) {
  const customerId = payment?.customerId || payment?.optional?.customerId;
  if (customerId) {
    const byCustomer = await prisma.restaurantOrganization.findFirst({
      where: { flowCustomerId: String(customerId), isDeleted: false },
      select: { id: true },
    });
    if (byCustomer) return byCustomer.id;
  }

  const commerceOrder = String(payment?.commerceOrder || '');
  const susMatch = commerceOrder.match(/sus_[a-z0-9]+/i);
  if (susMatch) {
    const bySub = await prisma.subscription.findFirst({
      where: { flowSubscriptionId: susMatch[0] },
      select: { organizationId: true },
    });
    if (bySub) return bySub.organizationId;
  }

  const payer = String(payment?.payer || '').trim().toLowerCase();
  if (payer) {
    const byOwner = await prisma.restaurantOrganization.findFirst({
      where: {
        isDeleted: false,
        OR: [
          { owner: { email: { equals: payer, mode: 'insensitive' } } },
          { billingEmail: { equals: payer, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    if (byOwner) return byOwner.id;
  }

  const flowOrder = payment?.flowOrder != null ? Number(payment.flowOrder) : null;
  if (!flowOrder) return null;

  const candidates = await prisma.subscription.findMany({
    where: { flowSubscriptionId: { not: null }, status: { in: ['active', 'grace', 'scheduled'] } },
    select: { organizationId: true, flowSubscriptionId: true },
    take: 200,
  });

  for (const sub of candidates) {
    try {
      const remote = await getFlowSubscription(sub.flowSubscriptionId);
      const invoices = Array.isArray(remote?.invoices) ? remote.invoices : [];
      const match = invoices.find((inv) => {
        const order = inv?.payment?.flowOrder ?? inv?.flowOrder;
        return Number(order) === flowOrder;
      });
      if (match) return sub.organizationId;
    } catch (err) {
      console.warn('[Flow] subscription lookup during webhook failed:', err?.message);
    }
  }
  return null;
}

function extractInvoiceId(payment, remoteSub) {
  if (payment?.optional?.invoiceId) return String(payment.optional.invoiceId);
  const invoices = Array.isArray(remoteSub?.invoices) ? remoteSub.invoices : [];
  const flowOrder = payment?.flowOrder != null ? Number(payment.flowOrder) : null;
  const match = invoices.find((inv) => Number(inv?.payment?.flowOrder) === flowOrder);
  return match?.id != null ? String(match.id) : null;
}

async function processFlowPaymentNotification(token) {
  if (!token) throw new Error('token requerido');

  const payment = await getPaymentStatus(token);
  const flowOrder = payment?.flowOrder != null ? Number(payment.flowOrder) : null;
  const organizationId = await resolveOrgFromFlowPayment(payment);
  if (!organizationId) {
    console.warn('[Flow] webhook payment could not be mapped to an organization', {
      flowOrder,
      payer: payment?.payer,
    });
    return { skipped: 'unmapped', payment };
  }

  const status = payment?.status;
  const { createReceiptFromFlowPayment } = require('./paymentReceiptService');
  const { enterGracePeriod } = require('./mercadopagoService');

  if (isFlowPaymentPaid(status)) {
    await createReceiptFromFlowPayment(payment, organizationId, {
      flowInvoiceId: extractInvoiceId(payment),
    });

    const reactivated = await prisma.subscription.updateMany({
      where: { organizationId, status: 'grace' },
      data: { status: 'active', gracePeriodEndsAt: null },
    });
    if (reactivated.count > 0) {
      const planService = require('./planService');
      planService.invalidateCache(organizationId);
    }

    try {
      const { resolveBillingAlerts } = require('./billing/billingEmailService');
      await resolveBillingAlerts(organizationId, ['checkout_creation_failed', 'grace_entered']);
    } catch (alertErr) {
      console.warn('[Flow] resolveBillingAlerts failed:', alertErr?.message);
    }

    try {
      const referralService = require('./referralService');
      await referralService.markFirstPayment(organizationId);
    } catch (refErr) {
      console.warn('[Flow] markFirstPayment failed:', refErr?.message);
    }

    const { computePeriodEnd } = require('../lib/billingPeriod');
    const activeSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'active' },
      include: { plan: true },
    });
    if (activeSub?.plan) {
      const periodAnchor = payment?.paymentData?.date
        ? new Date(payment.paymentData.date)
        : new Date();
      const nextPeriod = computePeriodEnd(periodAnchor, activeSub.plan);
      if (nextPeriod) {
        await prisma.subscription.update({
          where: { id: activeSub.id },
          data: { currentPeriodEnd: nextPeriod },
        });
      }
    }
    return { processed: 'paid', organizationId, flowOrder };
  }

  if (isFlowPaymentRejected(status)) {
    const active = await prisma.subscription.findFirst({
      where: { organizationId, status: { in: ['active', 'grace'] } },
      select: { id: true, status: true },
    });
    if (active) {
      await enterGracePeriod(organizationId);
    }
    return { processed: 'rejected', organizationId, flowOrder };
  }

  return { processed: 'pending', organizationId, flowOrder };
}

async function syncLocalSubscriptionFromFlow(localSub) {
  if (!localSub.flowSubscriptionId) return { skipped: true };
  const remote = await getFlowSubscription(localSub.flowSubscriptionId);
  const status = remote?.status;
  const morose = Number(remote?.morose) === 1;

  if (!isFlowSubscriptionActive(status)) {
    const { handleFlowSubscriptionCancelled } = require('./billing/handleFlowSubscriptionTerminalStatus');
    await handleFlowSubscriptionCancelled(localSub.organizationId, localSub.flowSubscriptionId, String(status));
    return { action: 'terminal', status };
  }

  if (morose) {
    const { enterGracePeriod } = require('./mercadopagoService');
    if (localSub.status === 'active') {
      await enterGracePeriod(localSub.organizationId);
    }
    return { action: 'morose' };
  }

  if (remote?.next_invoice_date) {
    const next = new Date(remote.next_invoice_date);
    if (!Number.isNaN(next.getTime())) {
      await prisma.subscription.update({
        where: { id: localSub.id },
        data: { currentPeriodEnd: next },
      });
      return { action: 'synced_period' };
    }
  }

  return { action: 'ok', status };
}

module.exports = {
  IVA_RATE,
  FlowApiError,
  EXTERNAL_ID_PREFIX,
  buildFlowPlanId,
  resolveFlowInterval,
  computeFlowGrossAmount,
  grossAmountFromNet,
  hasEnrolledCard,
  isFlowPaymentPaid,
  isFlowPaymentRejected,
  ensureFlowCustomer,
  ensureFlowPlan,
  createCardRegistration,
  confirmFromRegisterToken,
  cancelFlowSubscription,
  getFlowSubscription,
  getRegisterStatus,
  getPaymentStatus,
  startCardEnrollmentCheckout,
  subscribeWithEnrolledCard,
  processFlowPaymentNotification,
  syncLocalSubscriptionFromFlow,
  resolveOrgFromFlowPayment,
};
