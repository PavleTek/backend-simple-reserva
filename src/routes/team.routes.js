const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { hashPassword } = require('../utils/password');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');

const router = express.Router();

router.use(authenticateToken);

router.get(
  '/',
  authenticateRoles(['owner', 'admin']),
  async (req, res, next) => {
    try {
      const members = await prisma.user.findMany({
        where: { restaurantId: req.user.restaurantId },
        select: {
          id: true,
          email: true,
          name: true,
          lastName: true,
          role: true,
          lastLogin: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      res.json(members);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  authenticateRoles(['owner']),
  async (req, res, next) => {
    try {
      const { email, name, lastName, temporaryPassword } = req.body;

      if (!email || !temporaryPassword) {
        throw new ValidationError('Email and temporaryPassword are required');
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new ValidationError('A user with this email already exists');
      }

      const hashedPassword = await hashPassword(temporaryPassword);

      const user = await prisma.user.create({
        data: {
          email,
          name: name || null,
          lastName: lastName || null,
          hashedPassword,
          role: 'admin',
          restaurantId: req.user.restaurantId,
        },
        select: {
          id: true,
          email: true,
          name: true,
          lastName: true,
          role: true,
          createdAt: true,
        },
      });

      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/:userId',
  authenticateRoles(['owner']),
  async (req, res, next) => {
    try {
      if (req.params.userId === req.user.id) {
        throw new ForbiddenError('Cannot remove yourself');
      }

      const target = await prisma.user.findUnique({
        where: { id: req.params.userId },
      });

      if (!target || target.restaurantId !== req.user.restaurantId) {
        throw new NotFoundError('User not found');
      }

      if (target.role === 'owner') {
        throw new ForbiddenError('Cannot remove an owner');
      }

      if (target.role !== 'admin') {
        throw new ForbiddenError('Can only remove admin users');
      }

      await prisma.user.delete({ where: { id: req.params.userId } });

      res.json({ message: 'Team member removed' });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
