/**
 * Sends day-before reminder SMS for confirmed reservations.
 * Runs daily at 10:00 Chile time (configurable).
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { sendReservationReminder } = require('../services/notificationService');
const { canSendReminders } = require('../services/subscriptionService');

function getTomorrowDateRange() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  return { start: tomorrow, end: tomorrowEnd };
}

async function runReminders() {
  const { start, end } = getTomorrowDateRange();
  const reservations = await prisma.reservation.findMany({
    where: {
      status: 'confirmed',
      dateTime: { gte: start, lt: end },
    },
    include: {
      restaurant: { select: { name: true } },
    },
  });

  let sent = 0;
  for (const r of reservations) {
    const allowed = await canSendReminders(r.restaurantId);
    if (!allowed) continue;

    const ok = await sendReservationReminder({
      customerPhone: r.customerPhone,
      restaurantName: r.restaurant.name,
      dateTime: r.dateTime,
      partySize: r.partySize,
      secureToken: r.secureToken,
      restaurantId: r.restaurantId,
    });
    if (ok) sent++;
  }

  if (reservations.length > 0) {
    console.log(`[ReminderJob] Sent ${sent}/${reservations.length} reminders for tomorrow`);
  }
}

function startReminderJob() {
  const schedule = process.env.REMINDER_CRON || '0 10 * * *';
  cron.schedule(schedule, runReminders, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log(`[ReminderJob] Scheduled reminder job: ${schedule} (${process.env.TZ || 'America/Santiago'})`);
}

module.exports = { startReminderJob, runReminders };
