const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = express.Router();

router.use(authenticateToken);
router.use(authenticateRoles(['owner', 'admin']));

router.get('/', async (req, res, next) => {
  try {
    const zones = await prisma.zone.findMany({
      where: { restaurantId: req.user.restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        tables: {
          where: { isActive: true },
          orderBy: { label: 'asc' },
        },
      },
    });

    res.json(zones);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, description, sortOrder } = req.body;

    if (!name) {
      throw new ValidationError('El nombre es obligatorio');
    }

    const zone = await prisma.zone.create({
      data: {
        restaurantId: req.user.restaurantId,
        name,
        description: description || null,
        sortOrder: sortOrder ?? 0,
      },
    });

    res.status(201).json(zone);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.id },
    });

    if (!zone || zone.restaurantId !== req.user.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    const { name, description, sortOrder } = req.body;

    const updated = await prisma.zone.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const zone = await prisma.zone.findUnique({
      where: { id: req.params.id },
    });

    if (!zone || zone.restaurantId !== req.user.restaurantId) {
      throw new NotFoundError('Zona no encontrada');
    }

    await prisma.zone.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ message: 'Zona eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
