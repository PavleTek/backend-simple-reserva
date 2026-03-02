const prisma = require('../lib/prisma');
const { NotFoundError, ValidationError } = require('../utils/errors');

const getRestaurant = async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.activeRestaurant.restaurantId },
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
      throw new NotFoundError('Restaurante no encontrado');
    }

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
};

const updateRestaurant = async (req, res, next) => {
  try {
    const { name, description, address, phone, email, slug, defaultSlotDurationMinutes, bufferMinutesBetweenReservations, advanceBookingLimitDays, minimumNoticeMinutes, noShowGracePeriodMinutes, logoUrl } = req.body;

    if (slug) {
      const existing = await prisma.restaurant.findUnique({
        where: { slug },
      });

      if (existing && existing.id !== req.activeRestaurant.restaurantId) {
        throw new ValidationError('El slug ya está en uso');
      }
    }

    const restaurant = await prisma.restaurant.update({
      where: { id: req.activeRestaurant.restaurantId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(slug !== undefined && { slug }),
        ...(defaultSlotDurationMinutes !== undefined && {
          defaultSlotDurationMinutes: Math.min(240, Math.max(15, parseInt(defaultSlotDurationMinutes, 10) || 60)),
        }),
        ...(bufferMinutesBetweenReservations !== undefined && {
          bufferMinutesBetweenReservations: Math.min(120, Math.max(0, parseInt(bufferMinutesBetweenReservations, 10) || 0)),
        }),
        ...(advanceBookingLimitDays !== undefined && {
          advanceBookingLimitDays: Math.min(365, Math.max(1, parseInt(advanceBookingLimitDays, 10) || 30)),
        }),
        ...(minimumNoticeMinutes !== undefined && {
          minimumNoticeMinutes: Math.min(1440, Math.max(0, parseInt(minimumNoticeMinutes, 10) || 0)),
        }),
        ...(noShowGracePeriodMinutes !== undefined && {
          noShowGracePeriodMinutes: Math.min(120, Math.max(0, parseInt(noShowGracePeriodMinutes, 10) || 15)),
        }),
        ...(logoUrl !== undefined && { logoUrl: logoUrl || null }),
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
