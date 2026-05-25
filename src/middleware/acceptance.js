'use strict';

const prisma = require('../lib/prisma');
const { getEffectiveTimezone } = require('../utils/timezone');
const { isBookingAcceptanceEnabled } = require('../lib/featureFlags');
const { isAcceptingBookingsNow } = require('../services/acceptanceEngine');

/**
 * Gate public booking creation when acceptance window is closed.
 * Expects req.restaurant to be set (slug lookup middleware or inline).
 */
async function requireAcceptanceOpen(req, res, next) {
  try {
    const restaurant = req.restaurant;
    if (!restaurant) return next();

    const mode = restaurant.bookingAcceptanceMode ?? 'ALWAYS_24_7';
    if (!isBookingAcceptanceEnabled() || mode === 'ALWAYS_24_7') {
      return next();
    }

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    const [schedules, acceptanceWindows] = await Promise.all([
      prisma.schedule.findMany({ where: { restaurantId: restaurant.id } }),
      mode === 'CUSTOM'
        ? prisma.bookingAcceptanceWindow.findMany({ where: { restaurantId: restaurant.id } })
        : Promise.resolve([]),
    ]);

    const result = isAcceptingBookingsNow(restaurant, schedules, acceptanceWindows, timezone);

    if (result.open) return next();

    return res.status(409).json({
      error: 'BOOKING_CLOSED',
      fallback: restaurant.bookingClosedFallback ?? 'MESSAGE',
      message: restaurant.bookingClosedMessage ?? null,
      contact: {
        phone: restaurant.bookingContactPhone ?? null,
        whatsapp: restaurant.bookingContactWhatsapp ?? null,
        email: restaurant.bookingContactEmail ?? null,
      },
      nextOpenAt: result.nextOpenAt ?? null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAcceptanceOpen };
