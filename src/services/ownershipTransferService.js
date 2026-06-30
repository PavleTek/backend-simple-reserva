'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { ROLES } = require('../auth/roles');
const { writeAuditLog } = require('./auditLogService');
const {
  sendTransferInvitationEmail,
  sendTransferInitiatedNoticeEmail,
  sendTransferAcceptedEmails,
  sendTransferDeclinedEmail,
  sendTransferCancelledEmail,
} = require('./ownershipTransferEmailService');
const {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} = require('../utils/errors');

const CONFIRM_TEXT = 'TRANSFERIR';
const TRANSFER_EXPIRY_DAYS = Number(process.env.OWNERSHIP_TRANSFER_EXPIRY_DAYS) || 7;
const RESEND_COOLDOWN_MS = 60 * 1000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateTransferToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashTransferToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getAcceptUrl(rawToken) {
  const base = process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175';
  return `${base.replace(/\/$/, '')}/transferencia/aceptar/${rawToken}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function serializeTransfer(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization?.name ?? null,
    status: row.status,
    targetEmail: row.targetEmail,
    targetUserId: row.targetUserId,
    outgoingOwnerDisposition: row.outgoingOwnerDisposition,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    fromOwner: row.fromOwner
      ? {
          id: row.fromOwner.id,
          email: row.fromOwner.email,
          name: row.fromOwner.name,
          lastName: row.fromOwner.lastName,
        }
      : null,
    initiatedBy: row.initiatedBy
      ? {
          id: row.initiatedBy.id,
          email: row.initiatedBy.email,
          name: row.initiatedBy.name,
          lastName: row.initiatedBy.lastName,
        }
      : null,
  };
}

async function resolveTargetUser(email) {
  return prisma.user.findUnique({
    where: { email },
    include: { ownedOrganization: { select: { id: true, name: true } } },
  });
}

async function validateTargetEmail(email, currentOwnerId) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new ValidationError('Ingresa un correo válido');
  }

  const targetUser = await resolveTargetUser(normalized);

  if (targetUser && targetUser.id === currentOwnerId) {
    throw new ValidationError('Ya eres la persona propietaria de esta organización');
  }

  if (targetUser?.role === ROLES.SUPER_ADMIN) {
    throw new ValidationError('No se puede transferir la propiedad a una cuenta de administrador');
  }

  if (targetUser?.ownedOrganization) {
    throw new ValidationError(
      'Esta persona ya es propietaria de otra organización. Un usuario solo puede ser propietario de una organización.',
    );
  }

  return { targetEmail: normalized, targetUserId: targetUser?.id ?? null };
}

async function getOrganizationForRestaurant(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          ownerId: true,
          isDeleted: true,
          owner: {
            select: { id: true, email: true, name: true, lastName: true },
          },
        },
      },
    },
  });
  if (!restaurant?.organization || restaurant.organization.isDeleted) {
    throw new NotFoundError('Organización no encontrada');
  }
  return restaurant.organization;
}

async function assertNoPendingTransfer(organizationId, tx = prisma) {
  const existing = await tx.ownershipTransfer.findFirst({
    where: { organizationId, status: 'pending' },
  });
  if (existing) {
    throw new AppError('Ya existe una transferencia pendiente para esta organización', 409);
  }
}

async function initiateTransfer({
  restaurantId,
  actorUserId,
  email,
  outgoingOwnerDisposition,
  confirmText,
}) {
  if (confirmText !== CONFIRM_TEXT) {
    throw new ValidationError(`Debes escribir ${CONFIRM_TEXT} para confirmar`);
  }

  const disposition = outgoingOwnerDisposition === 'leave' ? 'leave' : 'manager';
  const org = await getOrganizationForRestaurant(restaurantId);

  if (org.ownerId !== actorUserId) {
    throw new ForbiddenError('Solo el propietario puede transferir la organización');
  }

  const { targetEmail, targetUserId } = await validateTargetEmail(email, actorUserId);
  await assertNoPendingTransfer(org.id);

  const rawToken = generateTransferToken();
  const tokenHash = hashTransferToken(rawToken);
  const expiresAt = addDays(new Date(), TRANSFER_EXPIRY_DAYS);

  const transfer = await prisma.ownershipTransfer.create({
    data: {
      organizationId: org.id,
      initiatedByUserId: actorUserId,
      fromOwnerId: actorUserId,
      targetEmail,
      targetUserId,
      outgoingOwnerDisposition: disposition,
      status: 'pending',
      tokenHash,
      expiresAt,
    },
    include: {
      organization: { select: { name: true } },
      fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
    },
  });

  writeAuditLog({
    actorUserId,
    restaurantId,
    action: 'ownership.transfer.initiated',
    resourceType: 'ownership_transfer',
    resourceId: transfer.id,
    metadata: {
      organizationId: org.id,
      targetEmail,
      targetUserId,
      outgoingOwnerDisposition: disposition,
    },
  }).catch(() => {});

  try {
    await sendTransferInvitationEmail({
      transfer,
      acceptUrl: getAcceptUrl(rawToken),
      invitedByName: [org.owner?.name, org.owner?.lastName].filter(Boolean).join(' ') || org.owner?.email,
    });
    await sendTransferInitiatedNoticeEmail({ transfer, orgName: org.name });
  } catch (err) {
    console.error('[OwnershipTransfer] email send failed on initiate:', err.message);
  }

  return serializeTransfer(transfer);
}

async function getTransferStateForOrg(restaurantId, actorUserId) {
  const org = await getOrganizationForRestaurant(restaurantId);
  if (org.ownerId !== actorUserId) {
    throw new ForbiddenError('Solo el propietario puede ver las transferencias');
  }

  const [pending, history] = await Promise.all([
    prisma.ownershipTransfer.findFirst({
      where: { organizationId: org.id, status: 'pending' },
      include: {
        organization: { select: { name: true } },
        fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
        initiatedBy: { select: { id: true, email: true, name: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ownershipTransfer.findMany({
      where: { organizationId: org.id, status: { not: 'pending' } },
      include: {
        organization: { select: { name: true } },
        fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
        initiatedBy: { select: { id: true, email: true, name: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  return {
    pending: serializeTransfer(pending),
    history: history.map(serializeTransfer),
  };
}

async function cancelTransfer({ transferId, restaurantId, actorUserId }) {
  const org = await getOrganizationForRestaurant(restaurantId);
  if (org.ownerId !== actorUserId) {
    throw new ForbiddenError('Solo el propietario puede cancelar la transferencia');
  }

  const transfer = await prisma.ownershipTransfer.findFirst({
    where: { id: transferId, organizationId: org.id },
    include: { organization: { select: { name: true } }, targetUser: { select: { email: true } } },
  });
  if (!transfer) throw new NotFoundError('Transferencia no encontrada');
  if (transfer.status !== 'pending') {
    throw new AppError('La transferencia ya no está pendiente', 409);
  }

  const updated = await prisma.ownershipTransfer.update({
    where: { id: transfer.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
    include: { organization: { select: { name: true } }, fromOwner: { select: { email: true, name: true, lastName: true } } },
  });

  writeAuditLog({
    actorUserId,
    restaurantId,
    action: 'ownership.transfer.cancelled',
    resourceType: 'ownership_transfer',
    resourceId: transfer.id,
    metadata: { organizationId: org.id, targetEmail: transfer.targetEmail },
  }).catch(() => {});

  return serializeTransfer(updated);
}

async function resendTransfer({ transferId, restaurantId, actorUserId }) {
  const org = await getOrganizationForRestaurant(restaurantId);
  if (org.ownerId !== actorUserId) {
    throw new ForbiddenError('Solo el propietario puede reenviar la invitación');
  }

  const transfer = await prisma.ownershipTransfer.findFirst({
    where: { id: transferId, organizationId: org.id, status: 'pending' },
    include: {
      organization: { select: { name: true } },
      fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
    },
  });
  if (!transfer) throw new NotFoundError('Transferencia pendiente no encontrada');
  if (transfer.expiresAt <= new Date()) {
    throw new AppError('La transferencia expiró. Inicia una nueva.', 410);
  }

  const cooldownSince = new Date(Date.now() - RESEND_COOLDOWN_MS);
  if (transfer.updatedAt > cooldownSince) {
    throw new AppError('Espera un minuto antes de reenviar el correo', 429);
  }

  const rawToken = generateTransferToken();
  const tokenHash = hashTransferToken(rawToken);

  const updated = await prisma.ownershipTransfer.update({
    where: { id: transfer.id },
    data: { tokenHash, updatedAt: new Date() },
    include: {
      organization: { select: { name: true } },
      fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
    },
  });

  await sendTransferInvitationEmail({
    transfer: updated,
    acceptUrl: getAcceptUrl(rawToken),
    invitedByName: [org.owner?.name, org.owner?.lastName].filter(Boolean).join(' ') || org.owner?.email,
  });

  return { ...serializeTransfer(updated), resentAt: new Date().toISOString() };
}

async function findPendingTransferByToken(rawToken) {
  const tokenHash = hashTransferToken(rawToken);
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { tokenHash },
    include: {
      organization: { select: { id: true, name: true, isDeleted: true, ownerId: true } },
      fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
    },
  });
  if (!transfer) throw new NotFoundError('Invitación no encontrada o inválida');
  if (transfer.status !== 'pending') {
    throw new AppError('Esta invitación ya no está disponible', 410);
  }
  if (transfer.expiresAt <= new Date()) {
    await prisma.ownershipTransfer.update({
      where: { id: transfer.id },
      data: { status: 'expired' },
    });
    throw new AppError('Esta invitación expiró', 410);
  }
  if (transfer.organization.isDeleted) {
    throw new AppError('La organización ya no está disponible', 410);
  }
  return transfer;
}

async function getTransferPublicDetails(rawToken) {
  const transfer = await findPendingTransferByToken(rawToken);
  const targetUser = transfer.targetUserId
    ? await prisma.user.findUnique({ where: { id: transfer.targetUserId }, select: { id: true } })
    : await resolveTargetUser(transfer.targetEmail);

  return {
    organizationName: transfer.organization.name,
    invitedByName: [transfer.fromOwner?.name, transfer.fromOwner?.lastName]
      .filter(Boolean)
      .join(' ') || transfer.fromOwner?.email || 'Propietario',
    targetEmail: transfer.targetEmail,
    targetHasAccount: !!targetUser,
    expiresAt: transfer.expiresAt,
  };
}

function assertAcceptingUserMatches(transfer, user) {
  if (transfer.targetUserId) {
    if (user.id !== transfer.targetUserId) {
      throw new ForbiddenError('Tu cuenta no coincide con el correo invitado');
    }
    return;
  }
  if (normalizeEmail(user.email) !== normalizeEmail(transfer.targetEmail)) {
    throw new ForbiddenError('Tu cuenta no coincide con el correo invitado');
  }
}

async function executeAcceptanceTransaction(transfer, acceptingUser) {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const current = await tx.ownershipTransfer.findUnique({
      where: { id: transfer.id },
    });
    if (!current || current.status !== 'pending') {
      throw new AppError('La transferencia ya no está pendiente', 409);
    }
    if (current.expiresAt <= now) {
      await tx.ownershipTransfer.update({
        where: { id: current.id },
        data: { status: 'expired' },
      });
      throw new AppError('Esta invitación expiró', 410);
    }

    const org = await tx.restaurantOrganization.findUnique({
      where: { id: current.organizationId },
      include: {
        restaurants: { where: { isDeleted: false }, select: { id: true } },
        owner: { select: { id: true, email: true, name: true, lastName: true } },
      },
    });

    if (!org || org.isDeleted) {
      throw new ValidationError('La organización ya no está disponible');
    }
    if (org.ownerId !== current.fromOwnerId) {
      throw new AppError('La propiedad de la organización cambió. Esta transferencia ya no es válida.', 409);
    }

    const otherOwnedOrg = await tx.restaurantOrganization.findFirst({
      where: { ownerId: acceptingUser.id, id: { not: org.id } },
    });
    if (otherOwnedOrg) {
      throw new ValidationError(
        'Ya eres propietario de otra organización. Un usuario solo puede ser propietario de una organización.',
      );
    }

    const targetManager = await tx.organizationManager.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: acceptingUser.id } },
    });
    if (targetManager) {
      await tx.organizationManager.delete({ where: { id: targetManager.id } });
    }

    const targetHost = await tx.organizationHost.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: acceptingUser.id } },
    });
    if (targetHost) {
      await tx.organizationHost.delete({ where: { id: targetHost.id } });
    }

    await tx.restaurantOrganization.update({
      where: { id: org.id },
      data: { ownerId: acceptingUser.id },
    });

    await tx.user.update({
      where: { id: acceptingUser.id },
      data: { role: ROLES.OWNER },
    });

    const oldOwnerId = current.fromOwnerId;
    if (oldOwnerId) {
      if (current.outgoingOwnerDisposition === 'manager') {
        let manager = await tx.organizationManager.findUnique({
          where: { organizationId_userId: { organizationId: org.id, userId: oldOwnerId } },
        });
        if (!manager) {
          manager = await tx.organizationManager.create({
            data: { organizationId: org.id, userId: oldOwnerId },
          });
        }
        await tx.managerRestaurantAssignment.deleteMany({
          where: { organizationManagerId: manager.id },
        });
        if (org.restaurants.length > 0) {
          await tx.managerRestaurantAssignment.createMany({
            data: org.restaurants.map((r) => ({
              organizationManagerId: manager.id,
              restaurantId: r.id,
            })),
          });
        }
      } else {
        const oldManager = await tx.organizationManager.findUnique({
          where: { organizationId_userId: { organizationId: org.id, userId: oldOwnerId } },
        });
        if (oldManager) {
          await tx.organizationManager.delete({ where: { id: oldManager.id } });
        }
        const oldHost = await tx.organizationHost.findUnique({
          where: { organizationId_userId: { organizationId: org.id, userId: oldOwnerId } },
        });
        if (oldHost) {
          await tx.organizationHost.delete({ where: { id: oldHost.id } });
        }
      }

      await tx.user.update({
        where: { id: oldOwnerId },
        data: { role: ROLES.MANAGER },
      });
    }

    const updatedCount = await tx.ownershipTransfer.updateMany({
      where: { id: current.id, status: 'pending' },
      data: {
        status: 'accepted',
        acceptedAt: now,
        targetUserId: acceptingUser.id,
      },
    });
    if (updatedCount.count === 0) {
      throw new AppError('La transferencia ya no está pendiente', 409);
    }

    return { org, oldOwner: org.owner, acceptingUser };
  });
}

async function acceptTransfer({ rawToken, user }) {
  const transfer = await findPendingTransferByToken(rawToken);
  assertAcceptingUserMatches(transfer, user);

  const result = await executeAcceptanceTransaction(transfer, user);

  writeAuditLog({
    actorUserId: user.id,
    action: 'ownership.transfer.accepted',
    resourceType: 'ownership_transfer',
    resourceId: transfer.id,
    metadata: {
      organizationId: result.org.id,
      fromOwnerId: transfer.fromOwnerId,
      targetEmail: transfer.targetEmail,
      outgoingOwnerDisposition: transfer.outgoingOwnerDisposition,
    },
  }).catch(() => {});

  try {
    await sendTransferAcceptedEmails({
      organizationName: result.org.name,
      newOwner: user,
      oldOwner: result.oldOwner,
      stayedAsManager: transfer.outgoingOwnerDisposition === 'manager',
    });
  } catch (err) {
    console.error('[OwnershipTransfer] accept emails failed:', err.message);
  }

  return {
    organizationId: result.org.id,
    organizationName: result.org.name,
    status: 'accepted',
  };
}

async function declineTransfer({ rawToken, user }) {
  const transfer = await findPendingTransferByToken(rawToken);
  assertAcceptingUserMatches(transfer, user);

  const updated = await prisma.ownershipTransfer.update({
    where: { id: transfer.id },
    data: { status: 'declined', declinedAt: new Date(), targetUserId: user.id },
    include: {
      organization: { select: { name: true } },
      fromOwner: { select: { email: true, name: true, lastName: true } },
    },
  });

  writeAuditLog({
    actorUserId: user.id,
    action: 'ownership.transfer.declined',
    resourceType: 'ownership_transfer',
    resourceId: transfer.id,
    metadata: { organizationId: transfer.organizationId, targetEmail: transfer.targetEmail },
  }).catch(() => {});

  try {
    await sendTransferDeclinedEmail({ transfer: updated });
  } catch (err) {
    console.error('[OwnershipTransfer] decline email failed:', err.message);
  }

  return { status: 'declined' };
}

async function expirePendingTransfers() {
  const now = new Date();
  const expired = await prisma.ownershipTransfer.updateMany({
    where: { status: 'pending', expiresAt: { lt: now } },
    data: { status: 'expired' },
  });
  return expired.count;
}

async function cancelPendingForOrganization(organizationId) {
  await prisma.ownershipTransfer.updateMany({
    where: { organizationId, status: 'pending' },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

async function listTransfersAdmin({ page = 1, limit = 20, status, search }) {
  const skip = (page - 1) * limit;
  const where = {};

  if (status) {
    where.status = status;
  }

  if (search && search.trim()) {
    const q = search.trim();
    where.OR = [
      { targetEmail: { contains: q, mode: 'insensitive' } },
      { organization: { name: { contains: q, mode: 'insensitive' } } },
      { fromOwner: { email: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.ownershipTransfer.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true } },
        fromOwner: { select: { id: true, email: true, name: true, lastName: true } },
        targetUser: { select: { id: true, email: true, name: true, lastName: true } },
        initiatedBy: { select: { id: true, email: true, name: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.ownershipTransfer.count({ where }),
  ]);

  return {
    data: rows.map(serializeTransfer),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getTransferByTokenForRegistration(rawToken) {
  return findPendingTransferByToken(rawToken);
}

module.exports = {
  CONFIRM_TEXT,
  normalizeEmail,
  initiateTransfer,
  getTransferStateForOrg,
  cancelTransfer,
  resendTransfer,
  getTransferPublicDetails,
  acceptTransfer,
  declineTransfer,
  expirePendingTransfers,
  cancelPendingForOrganization,
  listTransfersAdmin,
  getTransferByTokenForRegistration,
  hashTransferToken,
};
