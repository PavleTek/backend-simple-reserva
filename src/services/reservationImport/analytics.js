'use strict';

const prisma = require('../../lib/prisma');

async function recomputeAnalyticsForDates(restaurantId, organizationId, dateStrs) {
  for (const dateStr of dateStrs) {
    const businessDate = new Date(`${dateStr}T12:00:00.000Z`);

    const count = await prisma.reservation.count({
      where: {
        restaurantId,
        businessDate,
        status: { not: 'cancelled' },
        source: { not: 'imported' },
      },
    });

    const importedCount = await prisma.reservation.count({
      where: {
        restaurantId,
        businessDate,
        status: { not: 'cancelled' },
        source: 'imported',
      },
    });

    const total = count + importedCount;

    if (total === 0) {
      await prisma.$executeRaw`
        DELETE FROM "ReservationAnalytics"
        WHERE "date" = ${dateStr}::date AND "restaurantId" = ${restaurantId};
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO "ReservationAnalytics" ("id", "date", "restaurantId", "organizationId", "reservationCount", "updatedAt")
        VALUES (gen_random_uuid()::text, ${dateStr}::date, ${restaurantId}, ${organizationId}, ${total}, NOW())
        ON CONFLICT ("date", "restaurantId") WHERE "restaurantId" IS NOT NULL
        DO UPDATE SET "reservationCount" = ${total}, "updatedAt" = NOW();
      `;
    }
  }
}

module.exports = { recomputeAnalyticsForDates };
