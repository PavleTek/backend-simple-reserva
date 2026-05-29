'use strict';

const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { computeAccessEnd } = require('./promoCodeService');

const REFERRAL_PLAN_SKU = 'plan-profesional';
const INVALID_REFERRAL_MSG = 'Código de referido no válido.';

const REFERRAL_STATUSES = {
  REGISTERED: 'registered',
  ONBOARDING_STARTED: 'onboarding_started',
  TRIAL_ACTIVE: 'trial_active',
  PAYMENT_PENDING: 'payment_pending',
  FIRST_PAYMENT_COMPLETED: 'first_payment_completed',
  AWAITING_ADMIN_APPROVAL: 'awaiting_admin_approval',
  APPROVED: 'approved',
  REWARD_APPLIED: 'reward_applied',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
};

function getReferralConfig() {
  return {
    rewardDays: Number(process.env.REFERRAL_REWARD_DAYS) || 30,
    refereeGrantDays: Number(process.env.REFERRAL_REFEREE_GRANT_DAYS) || 30,
    minActiveDays: Number(process.env.REFERRAL_MIN_ACTIVE_DAYS) || 30,
    creditExpiryMonths: Number(process.env.REFERRAL_CREDIT_EXPIRY_MONTHS) || 12,
    landingBaseUrl: (process.env.FRONTEND_LANDING_PAGE_URL || 'https://simplereserva.com').replace(/\/$/, ''),
  };
}

function computeCreditExpiresAt(from = new Date()) {
  const { creditExpiryMonths } = getReferralConfig();
  const d = new Date(from);
  d.setMonth(d.getMonth() + creditExpiryMonths);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeOrgId(orgId) {
  return typeof orgId === 'string' ? orgId.trim() : '';
}

async function orgHasActiveSubscription(organizationId, client = prisma) {
  const count = await client.subscription.count({
    where: { organizationId, isActiveSubscription: true },
  });
  return count > 0;
}

async function loadReferrerOrganization(orgId, client = prisma) {
  return client.restaurantOrganization.findUnique({
    where: { id: orgId },
    include: {
      owner: { select: { id: true, email: true, name: true, lastName: true } },
      restaurants: {
        where: { isDeleted: false },
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, logoUrl: true, phone: true },
      },
    },
  });
}

/**
 * Valida org referidora. Lanza ValidationError si no califica.
 */
async function validateReferrerOrgId(orgId, options = {}) {
  const normalized = normalizeOrgId(orgId);
  if (!normalized) {
    throw new ValidationError(INVALID_REFERRAL_MSG);
  }

  const referrerOrganization = await loadReferrerOrganization(normalized);
  if (!referrerOrganization || referrerOrganization.isDeleted) {
    throw new ValidationError(INVALID_REFERRAL_MSG);
  }

  const hasActive = await orgHasActiveSubscription(referrerOrganization.id);
  if (!hasActive) {
    throw new ValidationError(INVALID_REFERRAL_MSG);
  }

  const refereeEmail = (options.refereeEmail || '').toLowerCase().trim();
  const refereeUserId = options.refereeUserId || null;

  if (referrerOrganization.owner) {
    if (refereeUserId && referrerOrganization.ownerId === refereeUserId) {
      throw new ValidationError(INVALID_REFERRAL_MSG);
    }
    if (refereeEmail && referrerOrganization.owner.email.toLowerCase() === refereeEmail) {
      throw new ValidationError(INVALID_REFERRAL_MSG);
    }
  }

  return { referrerOrganization, referrerOwner: referrerOrganization.owner };
}

/**
 * Validación pública (landing / register preview). No lanza — devuelve null si inválido.
 */
async function getPublicReferrerInfo(orgId) {
  try {
    const { referrerOrganization } = await validateReferrerOrgId(orgId);
    const restaurant = referrerOrganization.restaurants[0] || null;
    return {
      referrerName: restaurant?.name || referrerOrganization.name,
      referrerLogoUrl: restaurant?.logoUrl || null,
      isActive: true,
      organizationId: referrerOrganization.id,
    };
  } catch {
    return null;
  }
}

/**
 * Intenta validar sin lanzar (signup silencioso).
 */
async function tryValidateReferrerOrgId(orgId, options = {}) {
  try {
    return await validateReferrerOrgId(orgId, options);
  } catch {
    return null;
  }
}

function buildAntiFraudNotes({
  referrerOrganization,
  refereeEmail,
  refereePhone,
  signupIp,
  referrerRestaurantPhone,
}) {
  const notes = [];
  const referrerRut = (referrerOrganization.billingTaxId || '').trim();
  if (refereePhone && referrerRestaurantPhone && refereePhone === referrerRestaurantPhone) {
    notes.push('Advertencia: teléfono del referido coincide con el local referidor.');
  }
  if (signupIp) {
    notes.push(`Registro desde IP: ${signupIp}`);
  }
  if (referrerRut) {
    notes.push(`RUT referidor registrado: ${referrerRut}`);
  }
  return notes.length ? notes.join(' ') : null;
}

/**
 * Grant de 30 días plan profesional al referido (sin PromoCode físico).
 */
async function applyReferralSignupGrant(tx) {
  const { refereeGrantDays } = getReferralConfig();
  const plan = await tx.plan.findFirst({
    where: { productSKU: REFERRAL_PLAN_SKU },
  });
  if (!plan) {
    throw new Error(`Plan no encontrado: ${REFERRAL_PLAN_SKU}`);
  }
  if (plan.comingSoon) {
    throw new ValidationError('El plan de referido no está disponible.');
  }
  const trialEndsAt = computeAccessEnd(refereeGrantDays, 'days');
  return { plan, trialEndsAt };
}

/**
 * Crea Referral + aplica grant dentro de la transacción de signup.
 */
async function attributeReferralOnSignup(
  {
    referrerOrgId,
    refereeOrgId,
    refereeUserId,
    refereeEmail,
    refereePhone,
    attributionSource = 'url',
    signupIp,
    signupUserAgent,
    utmSource,
    utmMedium,
    utmCampaign,
  },
  tx,
) {
  const validated = await tryValidateReferrerOrgId(referrerOrgId, {
    refereeEmail,
    refereeUserId,
  });
  if (!validated) {
    return null;
  }

  if (normalizeOrgId(referrerOrgId) === normalizeOrgId(refereeOrgId)) {
    return null;
  }

  const { referrerOrganization } = validated;
  const referrerRestaurantPhone = referrerOrganization.restaurants[0]?.phone || null;

  const internalNotes = buildAntiFraudNotes({
    referrerOrganization,
    refereeEmail,
    refereePhone,
    signupIp,
    referrerRestaurantPhone,
  });

  const referral = await tx.referral.create({
    data: {
      referrerOrganizationId: referrerOrganization.id,
      refereeOrganizationId: refereeOrgId,
      refereeEmail: refereeEmail || null,
      refereePhone: refereePhone || null,
      attributionSource: attributionSource === 'manual_input' ? 'manual_input' : 'url',
      status: REFERRAL_STATUSES.TRIAL_ACTIVE,
      signupIp: signupIp || null,
      signupUserAgent: signupUserAgent || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      internalNotes,
    },
  });

  return referral;
}

async function findReferralByRefereeOrg(refereeOrganizationId, client = prisma) {
  return client.referral.findUnique({
    where: { refereeOrganizationId },
    include: {
      referrerOrganization: { select: { id: true, name: true, ownerId: true } },
      refereeOrganization: { select: { id: true, name: true } },
    },
  });
}

async function markFirstPayment(refereeOrganizationId) {
  const referral = await prisma.referral.findUnique({
    where: { refereeOrganizationId },
  });
  if (!referral) return null;
  if (referral.firstPaymentAt) return referral;

  const now = new Date();
  return prisma.referral.update({
    where: { id: referral.id },
    data: {
      status: REFERRAL_STATUSES.FIRST_PAYMENT_COMPLETED,
      firstPaymentAt: now,
      qualifyingPaymentAt: now,
    },
  });
}

async function handlePaymentReversal(refereeOrganizationId) {
  const referral = await prisma.referral.findUnique({
    where: { refereeOrganizationId },
    include: { rewardCredit: true },
  });
  if (!referral) return null;

  await prisma.$transaction(async (tx) => {
    await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: REFERRAL_STATUSES.CANCELED,
        internalNotes: [
          referral.internalNotes,
          `Pago revertido o chargeback detectado el ${new Date().toISOString()}.`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    });

    if (referral.rewardCredit && referral.rewardCredit.status === 'available') {
      await tx.referralCredit.update({
        where: { id: referral.rewardCredit.id },
        data: { status: 'revoked', notes: 'Revocado por reversión de pago del referido.' },
      });
    }
  });

  return referral;
}

const BAD_PAYMENT_STATUSES = ['rejected', 'refunded', 'charged_back', 'in_process'];

async function evaluateForApproval(referralId) {
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
    include: {
      refereeOrganization: {
        include: {
          subscriptions: {
            where: { isActiveSubscription: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          paymentReceipts: { orderBy: { paymentDate: 'desc' }, take: 5 },
        },
      },
    },
  });

  if (!referral) {
    return { eligible: false, reason: 'Referido no encontrado.' };
  }

  if (referral.isFraud) {
    return { eligible: false, reason: 'Marcado como fraude.' };
  }

  if (['rejected', 'canceled', 'approved', 'reward_applied'].includes(referral.status)) {
    return { eligible: false, reason: `Estado terminal o en revisión: ${referral.status}.` };
  }

  if (!referral.firstPaymentAt) {
    return { eligible: false, reason: 'Sin primer pago confirmado.' };
  }

  const { minActiveDays } = getReferralConfig();
  const minActiveMs = minActiveDays * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(referral.firstPaymentAt).getTime() < minActiveMs) {
    return { eligible: false, reason: `Debe mantener suscripción activa al menos ${minActiveDays} días.` };
  }

  const sub = referral.refereeOrganization.subscriptions[0];
  if (!sub) {
    return { eligible: false, reason: 'Sin suscripción activa.' };
  }
  if (sub.status !== 'active') {
    return { eligible: false, reason: `Suscripción en estado ${sub.status}.` };
  }
  if (!sub.isActiveSubscription) {
    return { eligible: false, reason: 'Suscripción no activa.' };
  }

  const badReceipt = referral.refereeOrganization.paymentReceipts.find((r) =>
    BAD_PAYMENT_STATUSES.includes(String(r.mercadopagoStatus || '').toLowerCase()),
  );
  if (badReceipt) {
    return { eligible: false, reason: `Pago con estado ${badReceipt.mercadopagoStatus}.` };
  }

  return { eligible: true, referral };
}

async function approveReferral(referralId, adminId, options = {}) {
  const skipEligibilityCheck = options.skipEligibilityCheck === true;
  let referral;

  if (skipEligibilityCheck) {
    referral = await prisma.referral.findUnique({ where: { id: referralId } });
    if (!referral) throw new NotFoundError('Referido no encontrado.');
    if (referral.isFraud) {
      throw new ValidationError('No se puede aprobar un referido marcado como fraude.');
    }
    if ([REFERRAL_STATUSES.APPROVED, REFERRAL_STATUSES.REWARD_APPLIED].includes(referral.status)) {
      throw new ValidationError('Este referido ya fue aprobado.');
    }
    if (referral.rewardCreditId) {
      throw new ValidationError('Ya existe un crédito asociado a este referido.');
    }
  } else {
    const evaluation = await evaluateForApproval(referralId);
    if (!evaluation.eligible) {
      throw new ValidationError(evaluation.reason || 'El referido no califica para aprobación.');
    }
    referral = evaluation.referral;
  }

  const { rewardDays } = getReferralConfig();
  const amountDays = options.amountDays != null ? Number(options.amountDays) : rewardDays;
  if (!Number.isFinite(amountDays) || amountDays <= 0) {
    throw new ValidationError('La cantidad de días debe ser mayor a cero.');
  }

  const now = new Date();
  const manualOverrideNote =
    skipEligibilityCheck && referral.status !== REFERRAL_STATUSES.AWAITING_ADMIN_APPROVAL
      ? `[Aprobación manual admin ${now.toISOString()} — estado previo: ${referral.status}]`
      : null;
  const mergedNotes = [options.notes, manualOverrideNote].filter(Boolean).join('\n') || null;

  return prisma.$transaction(async (tx) => {
    const credit = await tx.referralCredit.create({
      data: {
        organizationId: referral.referrerOrganizationId,
        source: 'referral',
        sourceReferralId: referral.id,
        amountDays,
        status: 'available',
        expiresAt: computeCreditExpiresAt(now),
        createdById: adminId,
        notes: mergedNotes,
      },
    });

    const updated = await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: REFERRAL_STATUSES.APPROVED,
        approvedAt: now,
        approvedById: adminId,
        rewardCreditId: credit.id,
        internalNotes: mergedNotes
          ? [referral.internalNotes, mergedNotes].filter(Boolean).join('\n')
          : referral.internalNotes,
      },
    });

    return { referral: updated, credit };
  });
}

async function rejectReferral(referralId, adminId, reason) {
  if (!reason || !reason.trim()) {
    throw new ValidationError('Debes indicar un motivo de rechazo.');
  }
  const referral = await prisma.referral.findUnique({ where: { id: referralId } });
  if (!referral) throw new NotFoundError('Referido no encontrado.');

  return prisma.referral.update({
    where: { id: referralId },
    data: {
      status: REFERRAL_STATUSES.REJECTED,
      rejectedAt: new Date(),
      approvedById: adminId,
      rejectionReason: reason.trim(),
    },
  });
}

async function markAsFraud(referralId, adminId, note) {
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
    include: { rewardCredit: true },
  });
  if (!referral) throw new NotFoundError('Referido no encontrado.');

  return prisma.$transaction(async (tx) => {
    if (referral.rewardCredit && referral.rewardCredit.status === 'available') {
      await tx.referralCredit.update({
        where: { id: referral.rewardCredit.id },
        data: { status: 'revoked', notes: 'Revocado por fraude.' },
      });
    }
    return tx.referral.update({
      where: { id: referralId },
      data: {
        isFraud: true,
        fraudNote: note?.trim() || null,
        status: REFERRAL_STATUSES.REJECTED,
        rejectedAt: new Date(),
        approvedById: adminId,
      },
    });
  });
}

async function revokeReward(referralId, adminId) {
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
    include: { rewardCredit: true },
  });
  if (!referral) throw new NotFoundError('Referido no encontrado.');
  if (!referral.rewardCredit) {
    throw new ValidationError('Este referido no tiene recompensa asociada.');
  }
  if (!['available', 'applied'].includes(referral.rewardCredit.status)) {
    throw new ValidationError('La recompensa no puede revocarse en su estado actual.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.referralCredit.update({
      where: { id: referral.rewardCredit.id },
      data: {
        status: 'revoked',
        notes: [referral.rewardCredit.notes, `Revocado por admin ${adminId}`].filter(Boolean).join('\n'),
      },
    });
    return tx.referral.update({
      where: { id: referralId },
      data: {
        status: REFERRAL_STATUSES.CANCELED,
        internalNotes: [referral.internalNotes, 'Recompensa revocada por administrador.'].filter(Boolean).join('\n'),
      },
    });
  });
}

async function getAvailableCredits(organizationId, client = prisma) {
  const now = new Date();
  return client.referralCredit.findMany({
    where: {
      organizationId,
      status: 'available',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function getAvailableCreditDays(organizationId, client = prisma) {
  const credits = await getAvailableCredits(organizationId, client);
  return credits.reduce((sum, c) => sum + c.amountDays, 0);
}

/**
 * Consume créditos disponibles y los amarra a una suscripción (transaccional, anti-doble-gasto).
 */
async function consumeCreditsForSubscription({ organizationId, subscriptionId, tx: externalTx }) {
  const run = async (tx) => {
    const credits = await getAvailableCredits(organizationId, tx);
    if (!credits.length) {
      return { totalDays: 0, freeUntil: null, creditIds: [] };
    }

    const creditIds = credits.map((c) => c.id);
    const totalDays = credits.reduce((sum, c) => sum + c.amountDays, 0);
    const now = new Date();

    const updated = await tx.referralCredit.updateMany({
      where: {
        id: { in: creditIds },
        organizationId,
        status: 'available',
      },
      data: {
        status: 'applied',
        appliedAt: now,
        appliedToSubscriptionId: subscriptionId,
      },
    });

    if (updated.count !== creditIds.length) {
      const err = new Error('Los créditos ya no están disponibles. Intenta nuevamente.');
      err.statusCode = 409;
      throw err;
    }

    await tx.referral.updateMany({
      where: {
        referrerOrganizationId: organizationId,
        status: REFERRAL_STATUSES.APPROVED,
        rewardCreditId: { in: creditIds },
      },
      data: { status: REFERRAL_STATUSES.REWARD_APPLIED, rewardAppliedAt: now },
    });

    return { totalDays, freeUntil: addDays(now, totalDays), creditIds };
  };

  if (externalTx) return run(externalTx);
  return prisma.$transaction(run);
}

/**
 * Libera créditos aplicados a una suscripción (activación fallida / reversa de reserva).
 */
async function releaseCreditsForSubscription(subscriptionId, client = prisma) {
  const credits = await client.referralCredit.findMany({
    where: { appliedToSubscriptionId: subscriptionId, status: 'applied' },
    select: { id: true },
  });
  if (!credits.length) return 0;

  const creditIds = credits.map((c) => c.id);
  const result = await client.referralCredit.updateMany({
    where: { id: { in: creditIds }, status: 'applied' },
    data: {
      status: 'available',
      appliedAt: null,
      appliedToSubscriptionId: null,
    },
  });

  await client.referral.updateMany({
    where: {
      rewardCreditId: { in: creditIds },
      status: REFERRAL_STATUSES.REWARD_APPLIED,
    },
    data: { status: REFERRAL_STATUSES.APPROVED, rewardAppliedAt: null },
  });

  return result.count;
}

/**
 * Reserva créditos para un checkout y calcula startDate con días extra.
 */
async function applyAvailableCreditsOnNextCheckout(organizationId, plannedStartDate, checkoutSessionId) {
  if (!checkoutSessionId) {
    const err = new Error('checkoutSessionId requerido para reservar créditos de referido.');
    err.statusCode = 500;
    throw err;
  }

  const credits = await getAvailableCredits(organizationId);
  if (!credits.length) {
    return { startDate: plannedStartDate ? new Date(plannedStartDate) : null, totalDays: 0, creditIds: [] };
  }

  const totalDays = credits.reduce((sum, c) => sum + c.amountDays, 0);
  const base = plannedStartDate ? new Date(plannedStartDate) : new Date();
  const startDate = addDays(base, totalDays);

  const creditIds = credits.map((c) => c.id);
  const pendingKey = `checkout:${checkoutSessionId}`;

  await prisma.referralCredit.updateMany({
    where: { id: { in: creditIds }, status: 'available' },
    data: {
      status: 'applied',
      appliedAt: new Date(),
      appliedToSubscriptionId: pendingKey,
    },
  });

  return { startDate, totalDays, creditIds };
}

async function markCreditsApplied(organizationId, subscriptionId, preapprovalId) {
  const alreadyLinked = await prisma.referralCredit.count({
    where: {
      organizationId,
      appliedToSubscriptionId: subscriptionId,
      status: 'applied',
    },
  });
  if (alreadyLinked > 0) return [];

  const checkoutSession = preapprovalId
    ? await prisma.checkoutSession.findFirst({
        where: { organizationId, mercadopagoPreapprovalId: preapprovalId },
        orderBy: { createdAt: 'desc' },
      })
    : null;

  const pendingKey = checkoutSession ? `checkout:${checkoutSession.id}` : null;

  const where = pendingKey
    ? { organizationId, appliedToSubscriptionId: pendingKey, status: 'applied' }
    : { organizationId, status: 'applied', appliedToSubscriptionId: { startsWith: 'checkout:' } };

  const credits = await prisma.referralCredit.findMany({ where });
  if (!credits.length) return [];

  await prisma.referralCredit.updateMany({
    where: { id: { in: credits.map((c) => c.id) } },
    data: { appliedToSubscriptionId: subscriptionId },
  });

  await prisma.referral.updateMany({
    where: {
      referrerOrganizationId: organizationId,
      status: REFERRAL_STATUSES.APPROVED,
      rewardCreditId: { in: credits.map((c) => c.id) },
    },
    data: { status: REFERRAL_STATUSES.REWARD_APPLIED, rewardAppliedAt: new Date() },
  });

  return credits;
}

async function releaseExpiredCheckoutCredits() {
  const expiredSessions = await prisma.checkoutSession.findMany({
    where: {
      status: 'pending',
      expiresAt: { lt: new Date() },
    },
    select: { id: true },
  });
  if (!expiredSessions.length) return 0;

  const keys = expiredSessions.map((s) => `checkout:${s.id}`);
  const result = await prisma.referralCredit.updateMany({
    where: {
      status: 'applied',
      appliedToSubscriptionId: { in: keys },
    },
    data: {
      status: 'available',
      appliedAt: null,
      appliedToSubscriptionId: null,
    },
  });
  return result.count;
}

async function getReferralSummary(organizationId) {
  const config = getReferralConfig();
  const referrals = await prisma.referral.findMany({
    where: { referrerOrganizationId: organizationId },
    select: { status: true },
  });

  const byStatus = referrals.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const availableCredits = await getAvailableCredits(organizationId);
  const appliedCredits = await prisma.referralCredit.findMany({
    where: { organizationId, status: 'applied' },
  });

  const creditsAvailableDays = availableCredits.reduce((s, c) => s + c.amountDays, 0);
  const creditsAppliedDays = appliedCredits.reduce((s, c) => s + c.amountDays, 0);

  return {
    referrerCode: organizationId,
    referralLink: `${config.landingBaseUrl}/ref/${organizationId}`,
    totalReferrals: referrals.length,
    byStatus,
    creditsAvailableDays,
    creditsAppliedDays,
    pendingApproval: byStatus[REFERRAL_STATUSES.AWAITING_ADMIN_APPROVAL] || 0,
    approved: (byStatus[REFERRAL_STATUSES.APPROVED] || 0) + (byStatus[REFERRAL_STATUSES.REWARD_APPLIED] || 0),
  };
}

async function listReferralsForOrganization(organizationId) {
  return prisma.referral.findMany({
    where: { referrerOrganizationId: organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      registeredAt: true,
      firstPaymentAt: true,
      approvedAt: true,
      refereeOrganization: { select: { name: true } },
    },
  });
}

async function runReferralEvaluationBatch() {
  const { minActiveDays } = getReferralConfig();
  const cutoff = new Date(Date.now() - minActiveDays * 24 * 60 * 60 * 1000);

  const candidates = await prisma.referral.findMany({
    where: {
      status: REFERRAL_STATUSES.FIRST_PAYMENT_COMPLETED,
      firstPaymentAt: { lte: cutoff },
      isFraud: false,
    },
  });

  let moved = 0;
  let canceled = 0;

  for (const referral of candidates) {
    const evaluation = await evaluateForApproval(referral.id);
    if (evaluation.eligible) {
      await prisma.referral.update({
        where: { id: referral.id },
        data: { status: REFERRAL_STATUSES.AWAITING_ADMIN_APPROVAL },
      });
      moved += 1;
    } else {
      await prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: REFERRAL_STATUSES.CANCELED,
          internalNotes: [referral.internalNotes, evaluation.reason].filter(Boolean).join('\n'),
        },
      });
      canceled += 1;
    }
  }

  await releaseExpiredCheckoutCredits();

  return { moved, canceled, evaluated: candidates.length };
}

module.exports = {
  REFERRAL_STATUSES,
  REFERRAL_PLAN_SKU,
  INVALID_REFERRAL_MSG,
  getReferralConfig,
  validateReferrerOrgId,
  tryValidateReferrerOrgId,
  getPublicReferrerInfo,
  applyReferralSignupGrant,
  attributeReferralOnSignup,
  findReferralByRefereeOrg,
  markFirstPayment,
  handlePaymentReversal,
  evaluateForApproval,
  approveReferral,
  rejectReferral,
  markAsFraud,
  revokeReward,
  getAvailableCredits,
  getAvailableCreditDays,
  consumeCreditsForSubscription,
  releaseCreditsForSubscription,
  applyAvailableCreditsOnNextCheckout,
  markCreditsApplied,
  addDays,
  releaseExpiredCheckoutCredits,
  getReferralSummary,
  listReferralsForOrganization,
  runReferralEvaluationBatch,
};
