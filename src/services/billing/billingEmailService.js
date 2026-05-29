'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { sendEmail } = require('../emailService');
const { BILLING_STRATEGY_MANUAL } = require('../../lib/billingDomain');
const { billingUrl } = require('../../utils/restaurantPanelUrl');
const {
  buildRenewalReminderSubject,
  buildRenewalReminderHtml,
} = require('../../templates/checkoutProRenewalReminderEmail');
const {
  buildPeriodOverdueSubject,
  buildPeriodOverdueHtml,
} = require('../../templates/billingPeriodOverdueEmail');
const {
  buildLastChanceSubject,
  buildLastChanceHtml,
} = require('../../templates/billingLastChanceEmail');
const {
  buildCheckoutPaymentRejectedSubject,
  buildCheckoutPaymentRejectedHtml,
} = require('../../templates/billingCheckoutPaymentRejectedEmail');
const {
  buildPaymentFailureSubject,
  buildPaymentFailureNotificationHtml,
} = require('../../templates/paymentFailureNotificationEmail');

const BILLING_EMAIL_KINDS = {
  RENEWAL_7D: 'renewal_7d',
  RENEWAL_4D: 'renewal_4d',
  RENEWAL_1D: 'renewal_1d',
  PERIOD_OVERDUE: 'period_overdue',
  GRACE_ENTERED: 'grace_entered',
  GRACE_LAST_CHANCE_1D: 'grace_last_chance_1d',
  CHECKOUT_PAYMENT_REJECTED: 'checkout_payment_rejected',
};

const KIND_LABELS = {
  [BILLING_EMAIL_KINDS.RENEWAL_7D]: 'Recordatorio 7 días antes',
  [BILLING_EMAIL_KINDS.RENEWAL_4D]: 'Recordatorio 4 días antes',
  [BILLING_EMAIL_KINDS.RENEWAL_1D]: 'Recordatorio 1 día antes',
  [BILLING_EMAIL_KINDS.PERIOD_OVERDUE]: 'Periodo vencido (entrada a gracia)',
  [BILLING_EMAIL_KINDS.GRACE_ENTERED]: 'Fallo de cobro (entrada a gracia)',
  [BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D]: 'Última oportunidad (gracia)',
  [BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED]: 'Pago rechazado en checkout',
};

function getAssetBaseUrl() {
  return (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
}

function getBillingFromEmail() {
  return process.env.RESEND_FROM_EMAIL || 'billing@simplereserva.cl';
}

/**
 * Normaliza currentPeriodEnd a clave YYYY-MM-DD (hora Chile).
 * @param {Date|string} date
 * @returns {string}
 */
function periodKeyFromPeriodEnd(date) {
  if (!date) return 'unknown';
  const d = new Date(date);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

/**
 * @param {Date|string} gracePeriodEndsAt
 * @returns {string}
 */
function periodKeyFromGrace(gracePeriodEndsAt) {
  const iso = gracePeriodEndsAt ? new Date(gracePeriodEndsAt).toISOString() : 'unknown';
  return `grace:${iso}`;
}

/**
 * @param {number} daysLeft
 * @returns {string|null}
 */
function renewalKindFromDaysLeft(daysLeft) {
  if (daysLeft === 7) return BILLING_EMAIL_KINDS.RENEWAL_7D;
  if (daysLeft === 4) return BILLING_EMAIL_KINDS.RENEWAL_4D;
  if (daysLeft === 1) return BILLING_EMAIL_KINDS.RENEWAL_1D;
  return null;
}

function parseRenewalReminderDays() {
  const raw =
    process.env.CHECKOUT_PRO_RENEWAL_REMINDER_DAYS ||
    process.env.CHECKOUT_PRO_RENEWAL_DAYS_BEFORE ||
    '7,4,1';
  if (typeof raw === 'number') return [raw];
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function msToDays(ms) {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * @param {string} subscriptionId
 * @param {string} kind
 * @param {string} periodKey
 */
async function hasBillingEmailLog(subscriptionId, kind, periodKey) {
  const existing = await prisma.billingEmailLog.findUnique({
    where: {
      subscriptionId_kind_periodKey: { subscriptionId, kind, periodKey },
    },
    select: { id: true },
  });
  return !!existing;
}

/**
 * @param {string} subscriptionId
 * @param {string} periodKey
 */
async function shouldSendGraceLastChance(subscriptionId, periodKey) {
  return !(await hasBillingEmailLog(
    subscriptionId,
    BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D,
    periodKey,
  ));
}

/**
 * @param {Object} sub
 * @param {number} daysLeft
 */
async function shouldSendRenewalReminder(sub, daysLeft) {
  if (!sub || sub.status !== 'active' || !sub.isActiveSubscription) return false;
  if (sub.billingStrategy !== BILLING_STRATEGY_MANUAL) return false;
  if (!sub.currentPeriodEnd) return false;

  const now = new Date();
  if (new Date(sub.currentPeriodEnd) <= now) return false;

  const kind = renewalKindFromDaysLeft(daysLeft);
  if (!kind) return false;

  const periodKey = periodKeyFromPeriodEnd(sub.currentPeriodEnd);
  if (await hasBillingEmailLog(sub.id, kind, periodKey)) return false;

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const pendingRenewal = await prisma.checkoutSession.findFirst({
    where: {
      organizationId: sub.organizationId,
      status: 'pending',
      billingStrategy: BILLING_STRATEGY_MANUAL,
      createdAt: { gte: fortyEightHoursAgo },
    },
    select: { id: true },
  });
  if (pendingRenewal) return false;

  return true;
}

/**
 * @param {Object} params
 * @returns {Promise<{ subject: string; html: string; preheader?: string }>}
 */
function buildBillingEmail(params) {
  const {
    kind,
    orgName,
    planName,
    periodEnd,
    gracePeriodEndsAt,
    checkoutUrl,
    panelUrl,
    ownerMessage,
    daysLeft,
  } = params;

  const assetBaseUrl = getAssetBaseUrl();
  const panel = panelUrl || billingUrl();

  if (kind === BILLING_EMAIL_KINDS.RENEWAL_7D || kind === BILLING_EMAIL_KINDS.RENEWAL_4D || kind === BILLING_EMAIL_KINDS.RENEWAL_1D) {
    const d = kind === BILLING_EMAIL_KINDS.RENEWAL_7D ? 7 : kind === BILLING_EMAIL_KINDS.RENEWAL_4D ? 4 : 1;
    return {
      subject: buildRenewalReminderSubject(d, orgName),
      html: buildRenewalReminderHtml({
        orgName,
        planName,
        periodEnd,
        checkoutUrl: checkoutUrl || panel,
        panelUrl: panel,
        daysLeft: daysLeft ?? d,
        assetBaseUrl,
        isReferralFreeWindow: params.isReferralFreeWindow === true,
      }),
    };
  }

  if (kind === BILLING_EMAIL_KINDS.PERIOD_OVERDUE) {
    return {
      subject: buildPeriodOverdueSubject(orgName),
      html: buildPeriodOverdueHtml({
        orgName,
        planName,
        periodEnd,
        gracePeriodEndsAt,
        checkoutUrl: checkoutUrl || panel,
        panelUrl: panel,
        assetBaseUrl,
      }),
    };
  }

  if (kind === BILLING_EMAIL_KINDS.GRACE_ENTERED) {
    return {
      subject: buildPaymentFailureSubject(orgName),
      html: buildPaymentFailureNotificationHtml({
        restaurantName: orgName,
        panelUrl: panel,
        gracePeriodEndsAt,
        recoveryUrl: checkoutUrl || undefined,
        assetBaseUrl,
      }),
    };
  }

  if (kind === BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D) {
    return {
      subject: buildLastChanceSubject(orgName),
      html: buildLastChanceHtml({
        orgName,
        gracePeriodEndsAt,
        checkoutUrl: checkoutUrl || panel,
        panelUrl: panel,
        assetBaseUrl,
      }),
    };
  }

  if (kind === BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED) {
    return {
      subject: buildCheckoutPaymentRejectedSubject(orgName),
      html: buildCheckoutPaymentRejectedHtml({
        orgName,
        ownerMessage: ownerMessage || 'No pudimos procesar el pago.',
        panelUrl: panel,
        assetBaseUrl,
      }),
    };
  }

  throw new Error(`Tipo de correo de facturación desconocido: ${kind}`);
}

/**
 * @param {Object} params
 */
async function sendBillingEmail(params) {
  const {
    organizationId,
    subscriptionId,
    kind,
    periodKey,
    toEmail,
    metadata = {},
    skipLog = false,
    ...buildParams
  } = params;

  if (!skipLog && subscriptionId && periodKey) {
    const exists = await hasBillingEmailLog(subscriptionId, kind, periodKey);
    if (exists && !metadata.manual) {
      return { sent: false, reason: 'already_sent' };
    }
  }

  const email = buildBillingEmail({ kind, ...buildParams });
  if (!toEmail) {
    return { sent: false, reason: 'no_email' };
  }

  await sendEmail({
    fromEmail: getBillingFromEmail(),
    toEmails: [toEmail],
    subject: email.subject,
    content: email.html,
    isHtml: true,
  });

  if (!skipLog && subscriptionId && periodKey) {
    try {
      await prisma.billingEmailLog.create({
        data: {
          organizationId,
          subscriptionId,
          kind,
          periodKey,
          metadata: metadata || undefined,
        },
      });
    } catch (err) {
      if (err?.code !== 'P2002') {
        logger.error({ err, organizationId, kind }, '[billingEmail] log insert failed');
      }
    }
  }

  return { sent: true, subject: email.subject, html: email.html };
}

function isOpsAlertsEnabled() {
  const v = process.env.BILLING_OPS_ALERTS_ENABLED;
  if (v === 'false' || v === '0') return false;
  return true;
}

/**
 * @param {Object} params
 */
async function createOpsAlert(params) {
  if (!isOpsAlertsEnabled()) return null;

  const {
    organizationId,
    subscriptionId,
    kind,
    severity = 'warning',
    title,
    detail,
    suggestedAction,
    mpPaymentId,
    mpStatus,
    mpStatusDetail,
    checkoutSessionId,
    dedupeKey,
  } = params;

  if (!dedupeKey) return null;

  try {
    return await prisma.billingOpsAlert.upsert({
      where: { dedupeKey },
      create: {
        organizationId,
        subscriptionId: subscriptionId || null,
        kind,
        severity,
        title,
        detail: detail || null,
        suggestedAction: suggestedAction || null,
        mpPaymentId: mpPaymentId || null,
        mpStatus: mpStatus || null,
        mpStatusDetail: mpStatusDetail || null,
        checkoutSessionId: checkoutSessionId || null,
        dedupeKey,
        status: 'open',
      },
      update: {
        detail: detail || undefined,
        suggestedAction: suggestedAction || undefined,
        mpStatus: mpStatus || undefined,
        mpStatusDetail: mpStatusDetail || undefined,
        status: 'open',
        resolvedAt: null,
        resolvedByUserId: null,
      },
    });
  } catch (err) {
    logger.error({ err, dedupeKey }, '[billingEmail] createOpsAlert failed');
    return null;
  }
}

/**
 * @param {string} organizationId
 * @param {string[]} [kinds]
 */
async function resolveBillingAlerts(organizationId, kinds = []) {
  const where = {
    organizationId,
    status: 'open',
  };
  if (kinds.length > 0) {
    where.kind = { in: kinds };
  }
  await prisma.billingOpsAlert.updateMany({
    where,
    data: { status: 'resolved', resolvedAt: new Date() },
  });
}

/**
 * @param {Object} sub — subscription with plan
 * @returns {Array<{ id: string; label: string }>}
 */
function listAvailableKindsForSubscription(sub) {
  if (!sub) return [];

  const kinds = [];

  if (sub.status === 'active' && sub.billingStrategy === BILLING_STRATEGY_MANUAL && sub.currentPeriodEnd) {
    kinds.push(
      { id: BILLING_EMAIL_KINDS.RENEWAL_7D, label: KIND_LABELS[BILLING_EMAIL_KINDS.RENEWAL_7D] },
      { id: BILLING_EMAIL_KINDS.RENEWAL_4D, label: KIND_LABELS[BILLING_EMAIL_KINDS.RENEWAL_4D] },
      { id: BILLING_EMAIL_KINDS.RENEWAL_1D, label: KIND_LABELS[BILLING_EMAIL_KINDS.RENEWAL_1D] },
      { id: BILLING_EMAIL_KINDS.PERIOD_OVERDUE, label: KIND_LABELS[BILLING_EMAIL_KINDS.PERIOD_OVERDUE] },
    );
  }

  if (sub.status === 'grace') {
    kinds.push(
      { id: BILLING_EMAIL_KINDS.GRACE_ENTERED, label: KIND_LABELS[BILLING_EMAIL_KINDS.GRACE_ENTERED] },
      { id: BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D, label: KIND_LABELS[BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D] },
    );
  }

  kinds.push({
    id: BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED,
    label: KIND_LABELS[BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED],
  });

  return kinds;
}

/**
 * Handle rejected checkout payment — notify owner + admin.
 * @param {Object} params
 */
async function handleCheckoutPaymentRejected(params) {
  const {
    organizationId,
    subscriptionId,
    mpPayment,
    orgName,
    ownerEmail,
  } = params;

  const { ownerMessage, adminHint, statusDetail, paymentId } = require('../../lib/mpPaymentFailureReason')
    .classifyMpPaymentFailure(mpPayment);

  const dedupeKey = paymentId
    ? `org:${organizationId}:payment_rejected:${paymentId}`
    : `org:${organizationId}:payment_rejected:${Date.now()}`;

  await createOpsAlert({
    organizationId,
    subscriptionId,
    kind: 'payment_rejected',
    severity: 'warning',
    title: `Pago rechazado — ${orgName}`,
    detail: adminHint,
    suggestedAction: 'Contactar al cliente y revisar Facturación / MP.',
    mpPaymentId: paymentId,
    mpStatus: mpPayment?.status || 'rejected',
    mpStatusDetail: statusDetail,
    dedupeKey,
  });

  if (!ownerEmail) return { sent: false };

  const periodKey = paymentId ? `payment:${paymentId}` : `payment:${Date.now()}`;
  return sendBillingEmail({
    organizationId,
    subscriptionId,
    kind: BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED,
    periodKey,
    toEmail: ownerEmail,
    orgName,
    ownerMessage,
    metadata: { mpPaymentId: paymentId, manual: false },
  });
}

module.exports = {
  BILLING_EMAIL_KINDS,
  KIND_LABELS,
  parseRenewalReminderDays,
  periodKeyFromPeriodEnd,
  periodKeyFromGrace,
  renewalKindFromDaysLeft,
  msToDays,
  hasBillingEmailLog,
  shouldSendGraceLastChance,
  shouldSendRenewalReminder,
  buildBillingEmail,
  sendBillingEmail,
  createOpsAlert,
  resolveBillingAlerts,
  listAvailableKindsForSubscription,
  handleCheckoutPaymentRejected,
  getAssetBaseUrl,
  isOpsAlertsEnabled,
};
