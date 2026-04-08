/**
 * Sends day-before reminder SMS for confirmed reservations.
 * Runs daily at 10:00 Chile time (configurable).
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
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
  try {
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
    logger.info({ sent, total: reservations.length }, '[ReminderJob] reminders sent for tomorrow');
  }
  } catch (err) {
    logger.error({ err }, '[ReminderJob] failed');
  }
}

function startReminderJob() {
  const schedule = process.env.REMINDER_CRON || '0 10 * * *';
  cron.schedule(schedule, runReminders, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule, tz: process.env.TZ || 'America/Santiago' }, '[ReminderJob] scheduled');
}

module.exports = { startReminderJob, runReminders };
