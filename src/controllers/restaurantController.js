const prisma = require('../lib/prisma');
const { NotFoundError, ValidationError } = require('../utils/errors');

const getRestaurant = async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.user.restaurantId },
      include: {
        zones: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: {
            tables: {
              where: { isActive: true },
              orderBy: { label: 'asc' },
            },
          },
        },
      },
    });

    if (!restaurant) {
      throw new NotFoundError('Restaurant not found');
    }

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
};

const updateRestaurant = async (req, res, next) => {
  try {
    const { name, description, address, phone, email, slug } = req.body;

    if (slug) {
      const existing = await prisma.restaurant.findUnique({
        where: { slug },
      });

      if (existing && existing.id !== req.user.restaurantId) {
        throw new ValidationError('Slug is already in use');
      }
    }

    const restaurant = await prisma.restaurant.update({
      where: { id: req.user.restaurantId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(slug !== undefined && { slug }),
      },
    });

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getRestaurant,
  updateRestaurant,
};
