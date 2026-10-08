'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { PAYMENT_PROVIDER_FLOW } = require('../../lib/billingDomain');

function isNoticeOpen(notice) {
  return !!(notice && notice.enabled && !notice.resolvedAt);
}

/**
 * @param {object|null|undefined} sub
 * @returns {{ isActiveSubscription: true, status?: string }|null}
 */
function accessRestorePatch(sub) {
  if (!sub) return null;
  if (sub.isActiveSubscription && sub.status !== 'expired') return null;
  return {
    isActiveSubscription: true,
    ...(sub.status === 'expired' ? { status: 'cancelled' } : {}),
  };
}

function excludeHeldOrganizations(where, heldOrganizationIds) {
  if (!heldOrganizationIds?.length) return where;
  return { ...where, organizationId: { notIn: heldOrganizationIds } };
}

function displayName(user) {
  const parts = [user?.name, user?.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function serializeNotice(notice) {
  if (!notice) {
    return { active: false, resolvedAt: null, createdAt: null, reads: [] };
  }
  return {
    active: isNoticeOpen(notice),
    resolvedAt: notice.resolvedAt ? notice.resolvedAt.toISOString() : null,
    createdAt: notice.createdAt ? notice.createdAt.toISOString() : null,
    reads: (notice.reads || []).map((read) => ({
      userId: read.userId,
      name: read.userName || displayName(read.user) || read.userEmail || 'Usuario',
      email: read.userEmail || read.user?.email || null,
      readAt: read.readAt.toISOString(),
    })),
  };
}

const noticeInclude = {
  reads: {
    orderBy: { readAt: 'asc' },
    include: { user: { select: { id: true, email: true, name: true, lastName: true } } },
  },
};

async function getNotice(organizationId) {
  return prisma.paymentRegularizationNotice.findUnique({
    where: { organizationId },
    include: noticeInclude,
  });
}

async function isNoticeOpenForOrganization(organizationId) {
  const notice = await prisma.paymentRegularizationNotice.findUnique({
    where: { organizationId },
    select: { enabled: true, resolvedAt: true },
  });
  return isNoticeOpen(notice);
}

async function openNoticeSummary(organizationId) {
  const open = await isNoticeOpenForOrganization(organizationId);
  return open ? { active: true } : null;
}

async function heldOrganizationIds() {
  const rows = await prisma.paymentRegularizationNotice.findMany({
    where: { enabled: true, resolvedAt: null },
    select: { organizationId: true },
  });
  return rows.map((row) => row.organizationId);
}

async function restoreAccess(organizationId) {
  const flagged = await prisma.subscription.findFirst({
    where: { organizationId, isActiveSubscription: true },
    orderBy: { startDate: 'desc' },
  });
  const sub = flagged || await prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { startDate: 'desc' },
  });
  const patch = accessRestorePatch(sub);
  if (!sub || !patch) return sub;
  return prisma.subscription.update({ where: { id: sub.id }, data: patch });
}

async function setEnabled(organizationId, enabled) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { id: true, paymentProvider: true },
  });
  if (!org) throw new NotFoundError('Organización no encontrada');

  if (enabled && org.paymentProvider !== PAYMENT_PROVIDER_FLOW) {
    throw new ValidationError('Pasa la cuenta a Flow antes de pedir la regularización.');
  }

  if (!enabled) {
    const existing = await prisma.paymentRegularizationNotice.findUnique({
      where: { organizationId },
    });
    if (existing && !existing.resolvedAt) {
      await prisma.paymentRegularizationNotice.update({
        where: { organizationId },
        data: { enabled: false },
      });
    }
    return serializeNotice(await getNotice(organizationId));
  }

  const notice = await prisma.paymentRegularizationNotice.upsert({
    where: { organizationId },
    create: { organizationId, enabled: true, resolvedAt: null },
    update: { enabled: true, resolvedAt: null },
  });
  await prisma.paymentRegularizationRead.deleteMany({ where: { noticeId: notice.id } });
  await restoreAccess(organizationId);
  const planService = require('../planService');
  planService.invalidateCache(organizationId);
  return serializeNotice(await getNotice(organizationId));
}

async function recordRead(organizationId, user) {
  const notice = await prisma.paymentRegularizationNotice.findUnique({
    where: { organizationId },
    select: { id: true, enabled: true, resolvedAt: true },
  });
  if (!isNoticeOpen(notice)) return { recorded: false };

  const name = displayName(user);
  await prisma.paymentRegularizationRead.upsert({
    where: { noticeId_userId: { noticeId: notice.id, userId: user.id } },
    create: {
      noticeId: notice.id,
      userId: user.id,
      userName: name,
      userEmail: user.email || null,
      readAt: new Date(),
    },
    update: {},
  });
  return { recorded: true };
}

async function resolveIfFlowSubscriptionActive(organizationId) {
  const notice = await prisma.paymentRegularizationNotice.findUnique({
    where: { organizationId },
    select: { id: true, enabled: true, resolvedAt: true },
  });
  if (!isNoticeOpen(notice)) return false;

  const flowSub = await prisma.subscription.findFirst({
    where: {
      organizationId,
      isActiveSubscription: true,
      flowSubscriptionId: { not: null },
      status: 'active',
    },
    select: { id: true },
  });
  if (!flowSub) return false;

  await prisma.paymentRegularizationNotice.update({
    where: { id: notice.id },
    data: { enabled: false, resolvedAt: new Date() },
  });
  return true;
}

async function latestPlanSku(organizationId) {
  const sub = await prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { startDate: 'desc' },
    include: { plan: { select: { productSKU: true } } },
  });
  return { sub, planSKU: sub?.plan?.productSKU || null };
}

/**
 * Inscribe la tarjeta en Flow (si falta) y crea la suscripción recurrente desde ahora.
 * No cobra los meses anteriores.
 */
async function startRegularization({ organizationId, userId, restaurantId }) {
  const notice = await prisma.paymentRegularizationNotice.findUnique({
    where: { organizationId },
    select: { enabled: true, resolvedAt: true },
  });
  if (!isNoticeOpen(notice)) {
    throw new ValidationError('No hay un aviso de regularización activo.');
  }

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { paymentProvider: true },
  });
  if (org?.paymentProvider !== PAYMENT_PROVIDER_FLOW) {
    throw new ValidationError('Esta cuenta no está en Flow.');
  }

  const already = await prisma.subscription.findFirst({
    where: {
      organizationId,
      isActiveSubscription: true,
      flowSubscriptionId: { not: null },
      status: 'active',
    },
    select: { id: true },
  });
  if (already) {
    await resolveIfFlowSubscriptionActive(organizationId);
    return { activated: true, providerId: PAYMENT_PROVIDER_FLOW };
  }

  const held = await restoreAccess(organizationId);
  const { sub, planSKU } = await latestPlanSku(organizationId);
  if (!planSKU) {
    throw new ValidationError('No se pudo determinar el plan de la cuenta.');
  }

  const flowBillingAdapter = require('./adapters/flowBillingAdapter');
  const result = await flowBillingAdapter.createCheckout({
    organizationId,
    userId,
    planSKU,
    restaurantId,
    when: 'now',
    pendingChangeFromSubscriptionId: (held || sub)?.id || null,
  });

  if (result?.activated) {
    await resolveIfFlowSubscriptionActive(organizationId);
  }
  return result;
}

module.exports = {
  isNoticeOpen,
  accessRestorePatch,
  excludeHeldOrganizations,
  serializeNotice,
  getNotice,
  isNoticeOpenForOrganization,
  openNoticeSummary,
  heldOrganizationIds,
  setEnabled,
  recordRead,
  resolveIfFlowSubscriptionActive,
  startRegularization,
};
