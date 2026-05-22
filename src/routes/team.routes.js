const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { hashPassword } = require('../utils/password');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');
const planService = require('../services/planService');
const { ROLES, ROLES_OWNER, ROLES_TEAM_VIEW } = require('../auth/roles');
const { writeAuditLog } = require('../services/auditLogService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

router.get(
  '/',
  authenticateRestaurantRoles(ROLES_TEAM_VIEW),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true },
      });

      if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

      const [managers, hosts] = await Promise.all([
        prisma.organizationManager.findMany({
          where: { organizationId: restaurant.organizationId },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                lastName: true,
                lastLogin: true,
                createdAt: true,
              },
            },
            restaurantAssignments: {
              where: { restaurantId },
              select: { id: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.organizationHost.findMany({
          where: { organizationId: restaurant.organizationId },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                lastName: true,
                lastLogin: true,
                createdAt: true,
              },
            },
            restaurantAssignments: {
              where: { restaurantId },
              select: { id: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const members = [
        ...managers
          .filter((m) => m.restaurantAssignments.length > 0)
          .map((m) => ({
            ...m.user,
            role: ROLES.MANAGER,
            organizationManagerId: m.id,
          })),
        ...hosts
          .filter((h) => h.restaurantAssignments.length > 0)
          .map((h) => ({
            ...h.user,
            role: ROLES.HOST,
            organizationHostId: h.id,
          })),
      ];

      res.json(members);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const {
        email,
        name,
        lastName,
        temporaryPassword,
        restaurantIds,
        role: inviteRole,
      } = req.body;
      const { restaurantId } = req.activeRestaurant;

      const memberRole =
        inviteRole === ROLES.HOST ? ROLES.HOST : ROLES.MANAGER;

      const restaurantIdsToAdd =
        Array.isArray(restaurantIds) && restaurantIds.length > 0
          ? restaurantIds
          : [restaurantId];

      if (!email || !temporaryPassword) {
        throw new ValidationError('Se requiere email y contraseña temporal');
      }

      const { getPasswordPolicyError } = require('../utils/passwordPolicy');
      const tempPwdErr = getPasswordPolicyError(temporaryPassword);
      if (tempPwdErr) {
        throw new ValidationError(tempPwdErr);
      }

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true },
      });

      for (const rid of restaurantIdsToAdd) {
        const canAdd = await planService.canAddTeamMember(req.user.id, rid, true);
        if (!canAdd.allowed) {
          throw new ValidationError(canAdd.reason || 'Límite de miembros alcanzado');
        }
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new ValidationError('Ya existe un usuario con este email');
      }

      const hashedPassword = await hashPassword(temporaryPassword);

      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            name: name || null,
            lastName: lastName || null,
            hashedPassword,
            role: memberRole,
          },
        });

        if (memberRole === ROLES.HOST) {
          const host = await tx.organizationHost.create({
            data: {
              organizationId: restaurant.organizationId,
              userId: newUser.id,
            },
          });
          await tx.hostRestaurantAssignment.createMany({
            data: restaurantIdsToAdd.map((rid) => ({
              organizationHostId: host.id,
              restaurantId: rid,
            })),
          });
        } else {
          const manager = await tx.organizationManager.create({
            data: {
              organizationId: restaurant.organizationId,
              userId: newUser.id,
            },
          });
          await tx.managerRestaurantAssignment.createMany({
            data: restaurantIdsToAdd.map((rid) => ({
              organizationManagerId: manager.id,
              restaurantId: rid,
            })),
          });
        }

        return newUser;
      });

      writeAuditLog({
        actorUserId: req.user.id,
        restaurantId,
        action: 'team.invite',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { role: memberRole, email: user.email },
      }).catch(() => {});

      res.status(201).json({
        id: user.id,
        email: user.email,
        name: user.name,
        lastName: user.lastName,
        role: memberRole,
        createdAt: user.createdAt,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/:userId/restaurants',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { restaurantId } = req.activeRestaurant;

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true },
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId,
          },
        },
        include: {
          restaurantAssignments: {
            select: { restaurantId: true },
          },
        },
      });

      if (manager) {
        return res.json({
          role: ROLES.MANAGER,
          restaurantIds: manager.restaurantAssignments.map((ra) => ra.restaurantId),
        });
      }

      const host = await prisma.organizationHost.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId,
          },
        },
        include: {
          restaurantAssignments: {
            select: { restaurantId: true },
          },
        },
      });

      res.json({
        role: host ? ROLES.HOST : null,
        restaurantIds: host ? host.restaurantAssignments.map((ra) => ra.restaurantId) : [],
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:userId',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { restaurantIds } = req.body;
      const { restaurantId: activeRestaurantId } = req.activeRestaurant;

      if (!Array.isArray(restaurantIds) || restaurantIds.length === 0) {
        throw new ValidationError('restaurantIds debe ser un array no vacío');
      }

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: activeRestaurantId },
        include: { organization: true },
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId,
          },
        },
      });

      const host = !manager
        ? await prisma.organizationHost.findUnique({
            where: {
              organizationId_userId: {
                organizationId: restaurant.organizationId,
                userId,
              },
            },
          })
        : null;

      if (!manager && !host) {
        throw new NotFoundError('Usuario no encontrado en esta organización');
      }

      if (restaurant.organization.ownerId !== req.user.id) {
        throw new ForbiddenError('No tienes permiso para gestionar este equipo');
      }

      const targetRestaurants = await prisma.restaurant.findMany({
        where: {
          id: { in: restaurantIds },
          organizationId: restaurant.organizationId,
        },
      });

      if (targetRestaurants.length !== restaurantIds.length) {
        throw new ForbiddenError('No tienes acceso a uno o más locales seleccionados');
      }

      for (const rid of restaurantIds) {
        const canAdd = await planService.canAddTeamMember(req.user.id, rid, true);
        if (!canAdd.allowed) {
          const alreadyAssigned = manager
            ? await prisma.managerRestaurantAssignment.findFirst({
                where: {
                  organizationManagerId: manager.id,
                  restaurantId: rid,
                },
              })
            : await prisma.hostRestaurantAssignment.findFirst({
                where: {
                  organizationHostId: host.id,
                  restaurantId: rid,
                },
              });
          if (!alreadyAssigned) {
            throw new ValidationError(canAdd.reason || 'Límite de miembros alcanzado');
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        if (manager) {
          await tx.managerRestaurantAssignment.deleteMany({
            where: { organizationManagerId: manager.id },
          });
          await tx.managerRestaurantAssignment.createMany({
            data: restaurantIds.map((rid) => ({
              organizationManagerId: manager.id,
              restaurantId: rid,
            })),
          });
        } else {
          await tx.hostRestaurantAssignment.deleteMany({
            where: { organizationHostId: host.id },
          });
          await tx.hostRestaurantAssignment.createMany({
            data: restaurantIds.map((rid) => ({
              organizationHostId: host.id,
              restaurantId: rid,
            })),
          });
        }
      });

      writeAuditLog({
        actorUserId: req.user.id,
        restaurantId: activeRestaurantId,
        action: 'team.update_assignments',
        resourceType: 'user',
        resourceId: userId,
        metadata: { restaurantIds },
      }).catch(() => {});

      res.json({ message: 'Accesos actualizados' });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/:userId',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      if (req.params.userId === req.user.id) {
        throw new ForbiddenError('No puedes eliminarte a ti mismo');
      }

      const { restaurantId } = req.activeRestaurant;
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true },
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId: req.params.userId,
          },
        },
      });

      if (manager) {
        await prisma.organizationManager.delete({ where: { id: manager.id } });
        writeAuditLog({
          actorUserId: req.user.id,
          restaurantId,
          action: 'team.remove',
          resourceType: 'user',
          resourceId: req.params.userId,
          metadata: { role: ROLES.MANAGER },
        }).catch(() => {});
        return res.json({ message: 'Miembro del equipo eliminado' });
      }

      const host = await prisma.organizationHost.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId: req.params.userId,
          },
        },
      });

      if (!host) {
        throw new NotFoundError('Usuario no encontrado');
      }

      await prisma.organizationHost.delete({ where: { id: host.id } });

      writeAuditLog({
        actorUserId: req.user.id,
        restaurantId,
        action: 'team.remove',
        resourceType: 'user',
        resourceId: req.params.userId,
        metadata: { role: ROLES.HOST },
      }).catch(() => {});

      res.json({ message: 'Miembro del equipo eliminado' });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
