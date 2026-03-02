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
  authenticateRestaurantRoles(['owner', 'admin']),
  async (req, res, next) => {
    try {
      const userRestaurants = await prisma.userRestaurant.findMany({
        where: { restaurantId: req.activeRestaurant.restaurantId },
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
        },
        orderBy: { createdAt: 'asc' },
      });

      const members = userRestaurants.map((ur) => ({
        ...ur.user,
        role: ur.role,
        userRestaurantId: ur.id,
      }));

      res.json(members);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  authenticateRestaurantRoles(['owner']),
  async (req, res, next) => {
    try {
      const { email, name, lastName, temporaryPassword, restaurantIds } = req.body;
      const restaurantIdsToAdd = Array.isArray(restaurantIds) && restaurantIds.length > 0
        ? restaurantIds
        : [req.activeRestaurant.restaurantId];

      if (!email || !temporaryPassword) {
        throw new ValidationError('Se requiere email y contraseña temporal');
      }

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
            role: 'admin',
          },
        });

        await tx.userRestaurant.createMany({
          data: restaurantIdsToAdd.map((rid) => ({
            userId: newUser.id,
            restaurantId: rid,
            role: 'admin',
          })),
        });

        return newUser;
      });

      res.status(201).json({
        id: user.id,
        email: user.email,
        name: user.name,
        lastName: user.lastName,
        role: 'admin',
        createdAt: user.createdAt,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/:userId/restaurants',
  authenticateRestaurantRoles(['owner']),
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      const ownerRestaurantIds = (await prisma.userRestaurant.findMany({
        where: { userId: req.user.id },
        select: { restaurantId: true },
      })).map((r) => r.restaurantId);

      const userRestaurants = await prisma.userRestaurant.findMany({
        where: {
          userId,
          restaurantId: { in: ownerRestaurantIds },
        },
        select: { restaurantId: true },
      });

      res.json({
        restaurantIds: userRestaurants.map((ur) => ur.restaurantId),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/:userId',
  authenticateRestaurantRoles(['owner']),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { restaurantIds } = req.body;

      if (!Array.isArray(restaurantIds) || restaurantIds.length === 0) {
        throw new ValidationError('restaurantIds debe ser un array no vacío');
      }

      const userRestaurant = await prisma.userRestaurant.findUnique({
        where: {
          userId_restaurantId: {
            userId,
            restaurantId: req.activeRestaurant.restaurantId,
          },
        },
      });

      if (!userRestaurant) {
        throw new NotFoundError('Usuario no encontrado en este restaurante');
      }

      if (userRestaurant.role === 'owner') {
        throw new ForbiddenError('No puedes modificar los accesos del propietario');
      }

      // Verificar que el owner tenga acceso a todos los restaurantIds
      const ownerRestaurantIds = (await prisma.userRestaurant.findMany({
        where: { userId: req.user.id },
        select: { restaurantId: true },
      })).map((r) => r.restaurantId);

      const invalidIds = restaurantIds.filter((rid) => !ownerRestaurantIds.includes(rid));
      if (invalidIds.length > 0) {
        throw new ForbiddenError('No tienes acceso a una o más ubicaciones seleccionadas');
      }

      await prisma.$transaction(async (tx) => {
        // Solo eliminar accesos a restaurantes que este owner gestiona
        await tx.userRestaurant.deleteMany({
          where: {
            userId,
            role: 'admin',
            restaurantId: { in: ownerRestaurantIds },
          },
        });
        await tx.userRestaurant.createMany({
          data: restaurantIds.map((rid) => ({
            userId,
            restaurantId: rid,
            role: 'admin',
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
  authenticateRestaurantRoles(['owner']),
  async (req, res, next) => {
    try {
      if (req.params.userId === req.user.id) {
        throw new ForbiddenError('No puedes eliminarte a ti mismo');
      }

      const userRestaurant = await prisma.userRestaurant.findUnique({
        where: {
          userId_restaurantId: {
            userId: req.params.userId,
            restaurantId: req.activeRestaurant.restaurantId,
          },
        },
        include: { user: true },
      });

      if (!userRestaurant) {
        throw new NotFoundError('Usuario no encontrado');
      }

      if (userRestaurant.role === 'owner') {
        throw new ForbiddenError('No puedes eliminar al propietario');
      }

      await prisma.userRestaurant.delete({
        where: { id: userRestaurant.id },
      });

      res.json({ message: 'Miembro del equipo eliminado' });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
