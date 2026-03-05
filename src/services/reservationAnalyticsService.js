const prisma = require('../lib/prisma');
const { DateTime } = require('luxon');
const { getEffectiveTimezone } = require('../utils/timezone');

/**
 * Increments the reservation counter for a specific date and restaurant.
 * Also increments a global aggregate counter for the same date.
 * 
 * @param {string} restaurantId - The ID of the restaurant
 * @param {string} organizationId - The ID of the organization
 * @param {Date} date - The date of the reservation creation (usually now)
 */
async function incrementReservationAnalytics(restaurantId, organizationId, date = new Date()) {
  try {
    // 1. Get restaurant to resolve its timezone
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: {
          include: {
            owner: { select: { country: true } }
          }
        }
      }
    });

    if (!restaurant) {
      console.error(`[ReservationAnalytics] Restaurant ${restaurantId} not found`);
      return;
    }

    const ownerCountry = restaurant.organization?.owner?.country || 'CL';
    const timezone = getEffectiveTimezone(restaurant, ownerCountry);

    // 2. Get the date string in the restaurant's timezone (YYYY-MM-DD)
    const localDate = DateTime.fromJSDate(date).setZone(timezone).toISODate();

    // 3. Upsert per-restaurant row
    // We use raw SQL to handle the partial unique index and atomic increment
    await prisma.$executeRaw`
      INSERT INTO "ReservationAnalytics" ("id", "date", "restaurantId", "organizationId", "reservationCount", "updatedAt")
      VALUES (gen_random_uuid()::text, ${localDate}::date, ${restaurantId}, ${organizationId}, 1, NOW())
      ON CONFLICT ("date", "restaurantId") WHERE "restaurantId" IS NOT NULL
      DO UPDATE SET "reservationCount" = "ReservationAnalytics"."reservationCount" + 1, "updatedAt" = NOW();
    `;

    // 4. Upsert global aggregate row (restaurantId = NULL, organizationId = NULL)
    await prisma.$executeRaw`
      INSERT INTO "ReservationAnalytics" ("id", "date", "restaurantId", "organizationId", "reservationCount", "updatedAt")
      VALUES (gen_random_uuid()::text, ${localDate}::date, NULL, NULL, 1, NOW())
      ON CONFLICT ("date") WHERE "restaurantId" IS NULL
      DO UPDATE SET "reservationCount" = "ReservationAnalytics"."reservationCount" + 1, "updatedAt" = NOW();
    `;

  } catch (error) {
    console.error('[ReservationAnalytics] Error incrementing analytics:', error);
    // We don't throw here to avoid failing the reservation creation if analytics fail
  }
}

module.exports = {
  incrementReservationAnalytics,
};
