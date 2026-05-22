const prisma = require('../lib/prisma');
const { ValidationError } = require('../utils/errors');
const { getEffectiveTimezone, COUNTRY_TIMEZONES } = require('../utils/timezone');
const r2LogosService = require('../services/r2LogosService');
const { isValidBookingThemeId } = require('../constants/bookingThemes');

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
    const {
      name,
      description,
      address,
      shortAddress,
      googlePlaceId,
      latitude,
      longitude,
      phone,
      email,
      slug,
      defaultSlotDurationMinutes,
      slotIntervalMinutes,
      reservationEndPolicy,
      reservationWindowMode,
      bufferMinutesBetweenReservations,
      advanceBookingLimitDays,
      minimumNoticeMinutes,
      noShowGracePeriodMinutes,
      requireEmail,
      requirePhoneNumber,
      holdsEnabled,
      holdTtlSeconds,
      logoUrl,
      timezone,
      scheduleMode,
      appearanceTheme,
    } = req.body;

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

    if (appearanceTheme !== undefined && !isValidBookingThemeId(appearanceTheme)) {
      throw new ValidationError('Paleta de apariencia no válida');
    }

    // If the owner is clearing the logo, delete the old R2 object (best-effort).
    if (logoUrl === null || logoUrl === '') {
      const current = await prisma.restaurant.findUnique({
        where: { id: req.activeRestaurant.restaurantId },
        select: { logoUrl: true },
      });
      if (current?.logoUrl) {
        const oldKey = r2LogosService.keyFromLogoUrl(current.logoUrl);
        if (oldKey) r2LogosService.deleteLogo(oldKey).catch(() => {});
      }
    }

    const restaurant = await prisma.restaurant.update({
      where: { id: req.activeRestaurant.restaurantId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(address !== undefined && { address }),
        ...(shortAddress !== undefined && { shortAddress: shortAddress || null }),
        ...(googlePlaceId !== undefined && { googlePlaceId: googlePlaceId || null }),
        ...(latitude !== undefined && { latitude: latitude !== null ? parseFloat(latitude) : null }),
        ...(longitude !== undefined && { longitude: longitude !== null ? parseFloat(longitude) : null }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(slug !== undefined && { slug }),
        ...(timezone !== undefined && { timezone }),
        ...(defaultSlotDurationMinutes !== undefined && {
          defaultSlotDurationMinutes: Math.min(240, Math.max(15, parseInt(defaultSlotDurationMinutes, 10) || 60)),
        }),
        ...(slotIntervalMinutes !== undefined && {
          slotIntervalMinutes: Math.min(180, Math.max(5, parseInt(slotIntervalMinutes, 10) || 30)),
        }),
        ...(reservationEndPolicy !== undefined && {
          reservationEndPolicy:
            reservationEndPolicy === 'ALLOW_OVERFLOW' ? 'ALLOW_OVERFLOW' : 'STRICT_END',
        }),
        ...(reservationWindowMode !== undefined && {
          reservationWindowMode:
            reservationWindowMode === 'custom' ? 'custom' : 'same_as_schedule',
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
        ...(requireEmail !== undefined && { requireEmail: Boolean(requireEmail) }),
        ...(requirePhoneNumber !== undefined && { requirePhoneNumber: Boolean(requirePhoneNumber) }),
        ...(holdsEnabled !== undefined && { holdsEnabled: Boolean(holdsEnabled) }),
        ...(holdTtlSeconds !== undefined && {
          holdTtlSeconds: Math.min(900, Math.max(60, parseInt(holdTtlSeconds, 10) || 300)),
        }),
        ...(scheduleMode !== undefined && { scheduleMode }),
        ...(appearanceTheme !== undefined && { appearanceTheme }),
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
