const prisma = require('../lib/prisma');
const { ValidationError } = require('../utils/errors');
const { getEffectiveTimezone, COUNTRY_TIMEZONES } = require('../utils/timezone');

const getRestaurant = async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.activeRestaurant.restaurantId },
      include: {
        organization: {
          include: {
            owner: { select: { country: true } }
          }
        }
      },
    });

    if (!restaurant) {
      throw new ValidationError('Restaurante no encontrado');
    }

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const effectiveTimezone = getEffectiveTimezone(restaurant, ownerCountry);

    res.json({
      ...restaurant,
      effectiveTimezone,
      organization: undefined // Remove sensitive/unneeded data
    });
  } catch (error) {
    next(error);
  }
};

const updateRestaurant = async (req, res, next) => {
  try {
    const { name, description, address, phone, email, slug, defaultSlotDurationMinutes, bufferMinutesBetweenReservations, advanceBookingLimitDays, minimumNoticeMinutes, noShowGracePeriodMinutes, logoUrl, timezone, scheduleMode } = req.body;

    if (slug) {
      const existing = await prisma.restaurant.findUnique({
        where: { slug },
      });

      if (existing && existing.id !== req.activeRestaurant.restaurantId) {
        throw new ValidationError('El slug ya está en uso');
      }
    }

    if (timezone !== undefined && timezone !== null) {
      const validTimezones = Object.values(COUNTRY_TIMEZONES);
      if (!validTimezones.includes(timezone)) {
        throw new ValidationError('Zona horaria no válida');
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
        ...(timezone !== undefined && { timezone }),
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
        ...(scheduleMode !== undefined && { scheduleMode }),
        ...(logoUrl !== undefined && { logoUrl: logoUrl || null }),
      },
    });

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
};

const completeOnboarding = async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.update({
      where: { id: req.activeRestaurant.restaurantId },
      data: { onboardingCompletedAt: new Date() },
    });
    res.json({ success: true, onboardingCompletedAt: restaurant.onboardingCompletedAt });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getRestaurant,
  updateRestaurant,
  completeOnboarding,
};
