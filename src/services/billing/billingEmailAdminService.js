'use strict';

const prisma = require('../../lib/prisma');
const mercadopagoCheckoutProService = require('../mercadopagoCheckoutProService');
const { createRecoveryPaymentLink } = require('./recoveryLinkService');
const { billingUrl } = require('../../utils/restaurantPanelUrl');
const {
  BILLING_EMAIL_KINDS,
  buildBillingEmail,
  sendBillingEmail,
  listAvailableKindsForSubscription,
  periodKeyFromPeriodEnd,
  periodKeyFromGrace,
  KIND_LABELS,
} = require('./billingEmailService');
const { classifyMpPaymentFailure } = require('../../lib/mpPaymentFailureReason');

async function loadSubscriptionForOrg(organizationId, subscriptionId) {
  const where = subscriptionId
    ? { id: subscriptionId, organizationId }
    : { organizationId, isActiveSubscription: true };

  return prisma.subscription.findFirst({
    where,
    include: {
      plan: { select: { name: true, productSKU: true } },
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { email: true, id: true } },
          restaurants: { take: 1, select: { id: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * @param {Object} params
 */
async function resolveEmailContext(params) {
  const { organizationId, kind, subscriptionId, dryRun = false } = params;

  const sub = await loadSubscriptionForOrg(organizationId, subscriptionId);
  if (!sub) {
    const err = new Error('Suscripción no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const org = sub.organization;
  const orgName = org.name;
  const planName = sub.plan?.name || 'Plan';
  const panelUrl = billingUrl();
  let checkoutUrl = panelUrl;
  let ownerMessage;

  const restaurantId = org.restaurants?.[0]?.id;
  const ownerId = org.owner?.id;

  if (
    kind === BILLING_EMAIL_KINDS.RENEWAL_7D ||
    kind === BILLING_EMAIL_KINDS.RENEWAL_4D ||
    kind === BILLING_EMAIL_KINDS.RENEWAL_1D
  ) {
    if (!dryRun && restaurantId && sub.plan?.productSKU) {
      const { checkoutUrl: url } = await mercadopagoCheckoutProService.createRenewalPreference({
        organizationId,
        planSKU: sub.plan.productSKU,
        subscriptionId: sub.id,
        restaurantId,
      });
      checkoutUrl = url;
    } else {
      checkoutUrl = `${panelUrl}?preview=renewal`;
    }
  } else if (
    kind === BILLING_EMAIL_KINDS.PERIOD_OVERDUE ||
    kind === BILLING_EMAIL_KINDS.GRACE_ENTERED ||
    kind === BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D
  ) {
    if (!dryRun && ownerId && restaurantId && sub.status === 'grace') {
      try {
        const link = await createRecoveryPaymentLink({
          organizationId,
          userId: ownerId,
          restaurantId,
        });
        checkoutUrl = link.paymentUrl;
      } catch {
        checkoutUrl = panelUrl;
      }
    } else {
      checkoutUrl = `${panelUrl}?preview=recovery`;
    }
  } else if (kind === BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED) {
    ownerMessage = classifyMpPaymentFailure({
      status: 'rejected',
      status_detail: 'cc_rejected_other_reason',
    }).ownerMessage;
  }

  const daysLeft =
    kind === BILLING_EMAIL_KINDS.RENEWAL_7D ? 7
      : kind === BILLING_EMAIL_KINDS.RENEWAL_4D ? 4
        : kind === BILLING_EMAIL_KINDS.RENEWAL_1D ? 1
          : undefined;

  const gracePeriodEndsAt = sub.gracePeriodEndsAt || (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d;
  })();

  return {
    sub,
    orgName,
    planName,
    periodEnd: sub.currentPeriodEnd,
    gracePeriodEndsAt,
    checkoutUrl,
    panelUrl,
    ownerMessage,
    daysLeft,
    toEmail: org.owner?.email || null,
  };
}

async function previewBillingEmail(params) {
  const ctx = await resolveEmailContext(params);
  const email = buildBillingEmail({
    kind: params.kind,
    orgName: ctx.orgName,
    planName: ctx.planName,
    periodEnd: ctx.periodEnd,
    gracePeriodEndsAt: ctx.gracePeriodEndsAt,
    checkoutUrl: ctx.checkoutUrl,
    panelUrl: ctx.panelUrl,
    ownerMessage: ctx.ownerMessage,
    daysLeft: ctx.daysLeft,
  });

  return {
    subject: email.subject,
    html: email.html,
    recipientEmail: ctx.toEmail,
    kind: params.kind,
    kindLabel: KIND_LABELS[params.kind] || params.kind,
    dryRun: !!params.dryRun,
  };
}

async function sendBillingEmailFromAdmin(params) {
  const { organizationId, kind, subscriptionId, toEmail, adminUserId } = params;
  const dryRun = false;
  const ctx = await resolveEmailContext({ organizationId, kind, subscriptionId, dryRun });
  const targetEmail = (toEmail || ctx.toEmail || '').trim();
  if (!targetEmail) {
    const err = new Error('No hay correo de destino');
    err.statusCode = 400;
    throw err;
  }

  let periodKey;
  const manualSuffix = `:manual:${Date.now()}`;
  if (kind === BILLING_EMAIL_KINDS.CHECKOUT_PAYMENT_REJECTED) {
    periodKey = `payment${manualSuffix}`;
  } else if (
    kind === BILLING_EMAIL_KINDS.GRACE_ENTERED ||
    kind === BILLING_EMAIL_KINDS.GRACE_LAST_CHANCE_1D
  ) {
    periodKey = `${periodKeyFromGrace(ctx.gracePeriodEndsAt)}${manualSuffix}`;
  } else {
    periodKey = `${periodKeyFromPeriodEnd(ctx.periodEnd || new Date())}${manualSuffix}`;
  }

  const result = await sendBillingEmail({
    organizationId,
    subscriptionId: ctx.sub.id,
    kind,
    periodKey,
    toEmail: targetEmail,
    orgName: ctx.orgName,
    planName: ctx.planName,
    periodEnd: ctx.periodEnd,
    gracePeriodEndsAt: ctx.gracePeriodEndsAt,
    checkoutUrl: ctx.checkoutUrl,
    panelUrl: ctx.panelUrl,
    ownerMessage: ctx.ownerMessage,
    daysLeft: ctx.daysLeft,
    metadata: { manual: true, sentByAdminUserId: adminUserId || null },
  });

  return {
    ...result,
    recipientEmail: targetEmail,
    kind,
  };
}

async function listKindsForOrganization(organizationId, subscriptionId) {
  const sub = await loadSubscriptionForOrg(organizationId, subscriptionId);
  if (!sub) return [];
  return listAvailableKindsForSubscription(sub);
}

module.exports = {
  previewBillingEmail,
  sendBillingEmailFromAdmin,
  listKindsForOrganization,
  loadSubscriptionForOrg,
};
