const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { hashPassword } = require('../utils/password');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');
const planService = require('../services/planService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

router.get(
  '/',
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;

      // Get the organization for this restaurant
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true }
      });

      if (!restaurant) throw new NotFoundError('Restaurante no encontrado');

      // Get all managers in the organization
      const managers = await prisma.organizationManager.findMany({
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
            select: { id: true }
          }
        },
        orderBy: { createdAt: 'asc' },
      });

      // Filter to only those assigned to THIS restaurant, or include all if needed?
      // Usually "team members" for a restaurant are those assigned to it.
      const members = managers
        .filter(m => m.restaurantAssignments.length > 0)
        .map((m) => ({
          ...m.user,
          role: 'restaurant_manager',
          organizationManagerId: m.id,
        }));

      res.json(members);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  authenticateRestaurantRoles(['restaurant_owner']),
  async (req, res, next) => {
    try {
      const { email, name, lastName, temporaryPassword, restaurantIds } = req.body;
      const { restaurantId } = req.activeRestaurant;
      
      const restaurantIdsToAdd = Array.isArray(restaurantIds) && restaurantIds.length > 0
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
        select: { organizationId: true }
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
            role: 'restaurant_manager',
          },
        });

        const manager = await tx.organizationManager.create({
          data: {
            organizationId: restaurant.organizationId,
            userId: newUser.id,
          }
        });

        await tx.managerRestaurantAssignment.createMany({
          data: restaurantIdsToAdd.map((rid) => ({
            organizationManagerId: manager.id,
            restaurantId: rid,
          })),
        });

        return newUser;
      });

      res.status(201).json({
        id: user.id,
        email: user.email,
        name: user.name,
        lastName: user.lastName,
        role: 'restaurant_manager',
        createdAt: user.createdAt,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/:userId/restaurants',
  authenticateRestaurantRoles(['restaurant_owner']),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { restaurantId } = req.activeRestaurant;

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true }
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId
          }
        },
        include: {
          restaurantAssignments: {
            select: { restaurantId: true }
          }
        }
      });

      res.json({
        restaurantIds: manager ? manager.restaurantAssignments.map((ra) => ra.restaurantId) : [],
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:userId',
  authenticateRestaurantRoles(['restaurant_owner']),
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
        include: { organization: true }
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId,
          },
        },
      });

      if (!manager) {
        throw new NotFoundError('Usuario no encontrado en esta organización');
      }

      // Verify owner owns the organization
      if (restaurant.organization.ownerId !== req.user.id) {
        throw new ForbiddenError('No tienes permiso para gestionar este equipo');
      }

      // Verify all restaurantIds belong to the same organization
      const targetRestaurants = await prisma.restaurant.findMany({
        where: {
          id: { in: restaurantIds },
          organizationId: restaurant.organizationId
        }
      });

      if (targetRestaurants.length !== restaurantIds.length) {
        throw new ForbiddenError('No tienes acceso a una o más ubicaciones seleccionadas');
      }

      await prisma.$transaction(async (tx) => {
        await tx.managerRestaurantAssignment.deleteMany({
          where: { organizationManagerId: manager.id },
        });
        await tx.managerRestaurantAssignment.createMany({
          data: restaurantIds.map((rid) => ({
            organizationManagerId: manager.id,
            restaurantId: rid,
          })),
        });
      });

      res.json({ message: 'Accesos actualizados' });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/:userId',
  authenticateRestaurantRoles(['restaurant_owner']),
  async (req, res, next) => {
    try {
      if (req.params.userId === req.user.id) {
        throw new ForbiddenError('No puedes eliminarte a ti mismo');
      }

      const { restaurantId } = req.activeRestaurant;
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { organizationId: true }
      });

      const manager = await prisma.organizationManager.findUnique({
        where: {
          organizationId_userId: {
            organizationId: restaurant.organizationId,
            userId: req.params.userId,
          },
        },
      });

      if (!manager) {
        throw new NotFoundError('Usuario no encontrado');
      }

      // In the new model, owners are not in OrganizationManager, so we don't need to check role here
      // as long as we are deleting from OrganizationManager.
      
      await prisma.organizationManager.delete({
        where: { id: manager.id },
      });

      res.json({ message: 'Miembro del equipo eliminado' });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
