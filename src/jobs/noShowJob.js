/**
 * Auto-marks confirmed reservations as no_show when past their time + grace period.
 * Runs every 5 minutes.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');

async function runNoShowMarking() {
  const now = new Date();

  const restaurants = await prisma.restaurant.findMany({
    where: { isActive: true },
    select: { id: true, noShowGracePeriodMinutes: true },
  });

  let totalMarked = 0;

  for (const restaurant of restaurants) {
    const graceMinutes = restaurant.noShowGracePeriodMinutes ?? 15;

    const reservations = await prisma.reservation.findMany({
      where: {
        restaurantId: restaurant.id,
        status: 'confirmed',
      },
      select: { id: true, dateTime: true, durationMinutes: true },
    });

    for (const r of reservations) {
      const cutoff = new Date(
        r.dateTime.getTime() + (r.durationMinutes + graceMinutes) * 60000
      );
      if (now >= cutoff) {
        await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'no_show' },
        });
        totalMarked++;
      }
    }
  }

  if (totalMarked > 0) {
    console.log(`[NoShowJob] Marked ${totalMarked} reservations as no-show`);
  }
}

function startNoShowJob() {
  cron.schedule('*/5 * * * *', runNoShowMarking, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log('[NoShowJob] Scheduled (every 5 minutes)');
}

module.exports = { startNoShowJob, runNoShowMarking };
