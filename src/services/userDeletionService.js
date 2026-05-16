const prisma = require('../lib/prisma');
const mercadopagoService = require('./mercadopagoService');

/**
 * Cascading admin user deletion.
 *
 * - If target is an org owner: soft-deletes the org + all its restaurants (keeps reservations
 *   alive), cancels active Mercado Pago preapprovals, hard-deletes all manager users, then
 *   hard-deletes the owner. The org row survives with isDeleted=true and ownerId=null.
 * - If target is not an org owner: just hard-deletes the user (Prisma cascades take care of
 *   OrganizationManager + ManagerRestaurantAssignment cleanup).
 *
 * Guards:
 *   - Cannot delete yourself.
 *   - Cannot delete another super_admin.
 *   - confirmEmail must match the target user's email (case-insensitive) to prevent accidents.
 */
async function deleteUserAsAdmin({ userId, confirmEmail, actingUser }) {
  if (!userId || typeof confirmEmail !== 'string') {
    const err = new Error('userId and confirmEmail are required');
    err.statusCode = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      ownedOrganization: {
        include: {
          subscriptions: {
            where: { isActiveSubscription: true },
          },
          managers: {
            select: { userId: true },
          },
        },
      },
    },
  });

  if (!user) {
    const err = new Error('Usuario no encontrado');
    err.statusCode = 404;
    throw err;
  }

  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    const err = new Error('El email ingresado no coincide con el usuario a eliminar');
    err.statusCode = 400;
    throw err;
  }

  if (user.id === actingUser.id) {
    const err = new Error('No puedes eliminarte a ti mismo');
    err.statusCode = 400;
    throw err;
  }

  if (user.role === 'super_admin') {
    const err = new Error('No se puede eliminar a otro super administrador');
    err.statusCode = 403;
    throw err;
  }

  const org = user.ownedOrganization;

  if (!org) {
    // Non-owner: simple hard delete. Prisma cascades clean up OrganizationManager rows.
    await prisma.user.delete({ where: { id: userId } });
    return {
      deletedUserId: userId,
      softDeletedOrgId: null,
      softDeletedRestaurantIds: [],
      cancelledSubscriptionIds: [],
      deletedManagerUserIds: [],
    };
  }

  // Owner path: cancel active MP preapprovals BEFORE the transaction (external API call).
  const activeSubsWithMP = org.subscriptions.filter((s) => s.mercadopagoPreapprovalId);
  const cancelledSubscriptionIds = [];

  for (const sub of activeSubsWithMP) {
    try {
      await mercadopagoService.cancelSubscription(sub.mercadopagoPreapprovalId);
      cancelledSubscriptionIds.push(sub.id);
      console.log('[UserDeletion] MP preapproval cancelled:', sub.mercadopagoPreapprovalId);
    } catch (err) {
      // Do not block deletion if MP call fails — preapproval may already be cancelled.
      console.warn('[UserDeletion] Could not cancel MP preapproval (continuing):', err?.message);
    }
  }

  const managerUserIds = org.managers.map((m) => m.userId);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Deactivate all active subscriptions for the org in the DB.
    await tx.subscription.updateMany({
      where: { organizationId: org.id, isActiveSubscription: true },
      data: {
        isActiveSubscription: false,
        status: 'cancelled',
        endDate: now,
        currentPeriodEnd: now,
        gracePeriodEndsAt: now,
      },
    });

    // Soft-delete all restaurants — keeps all Reservation rows alive.
    const updatedRestaurants = await tx.restaurant.findMany({
      where: { organizationId: org.id },
      select: { id: true },
    });
    await tx.restaurant.updateMany({
      where: { organizationId: org.id },
      data: { isDeleted: true, isActive: false },
    });

    // Soft-delete the organization; null out ownerId (FK is now SET NULL).
    await tx.restaurantOrganization.update({
      where: { id: org.id },
      data: { isDeleted: true, ownerId: null },
    });

    // Hard-delete manager users — Prisma cascade removes OrganizationManager +
    // ManagerRestaurantAssignment rows automatically.
    if (managerUserIds.length > 0) {
      await tx.user.deleteMany({ where: { id: { in: managerUserIds } } });
    }

    // Hard-delete the owner user. Because ownerId is now null, no cascade fires on the org row.
    await tx.user.delete({ where: { id: userId } });

    return updatedRestaurants.map((r) => r.id);
  });

  return {
    deletedUserId: userId,
    softDeletedOrgId: org.id,
    softDeletedRestaurantIds: result,
    cancelledSubscriptionIds,
    deletedManagerUserIds: managerUserIds,
  };
}

module.exports = { deleteUserAsAdmin };
