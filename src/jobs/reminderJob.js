/**
 * Sends day-before reminders to guests (email + optional SMS/WhatsApp).
 * Runs daily at 10:00 Chile time (configurable).
 */

const cron = require('node-cron');
const { DateTime } = require('luxon');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const {
  sendReservationReminder,
  sendReservationReminderEmail,
} = require('../services/notificationService');
const { canSendReminders } = require('../services/subscriptionService');
const { getEffectiveTimezone } = require('../utils/timezone');
const { buildReservationDayWhere } = require('../utils/reservationDateFilter');

function getJobTimezone() {
  return process.env.TZ || 'America/Santiago';
}

async function runReminders() {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: { isActive: true, isDeleted: false },
      include: {
        organization: {
          select: {
            owner: { select: { country: true } },
          },
        },
      },
    });

    let sentEmail = 0;
    let sentPhone = 0;
    let total = 0;

    for (const rest of restaurants) {
      const allowed = await canSendReminders(rest.id);
      if (!allowed) continue;

      const ownerCountry = rest.organization?.owner?.country || 'CL';
      const timezone = getEffectiveTimezone(rest, ownerCountry);
      const tomorrowYmd = DateTime.now().setZone(timezone).plus({ days: 1 }).toFormat('yyyy-MM-dd');

      const reservations = await prisma.reservation.findMany({
        where: buildReservationDayWhere(rest.id, tomorrowYmd, timezone, {
          status: 'confirmed',
        }),
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
          dateTime: true,
          partySize: true,
          secureToken: true,
          reminderEmailSent: true,
          restaurant: { select: { name: true, logoUrl: true, appearanceTheme: true } },
        },
      });

      total += reservations.length;

      for (const r of reservations) {
        if (r.customerEmail && !r.reminderEmailSent) {
          const emailOk = await sendReservationReminderEmail({
            customerEmail: r.customerEmail,
            customerName: r.customerName,
            restaurantName: r.restaurant.name,
            dateTime: r.dateTime,
            partySize: r.partySize,
            secureToken: r.secureToken,
            timezone,
            restaurantLogoUrl: r.restaurant.logoUrl || null,
            appearanceTheme: r.restaurant.appearanceTheme || null,
          });
          if (emailOk) {
            sentEmail++;
            await prisma.reservation.update({
              where: { id: r.id },
              data: { reminderEmailSent: true },
            });
          }
        }

        if (r.customerPhone) {
          const phoneOk = await sendReservationReminder({
            customerPhone: r.customerPhone,
            restaurantName: r.restaurant.name,
            dateTime: r.dateTime,
            partySize: r.partySize,
            secureToken: r.secureToken,
            restaurantId: rest.id,
          });
          if (phoneOk) sentPhone++;
        }
      }
    }

    if (total > 0) {
      logger.info(
        { total, sentEmail, sentPhone },
        '[ReminderJob] reminders sent for tomorrow',
      );
    }
  } catch (err) {
    logger.error({ err }, '[ReminderJob] failed');
  }
}

function startReminderJob() {
  const schedule = process.env.REMINDER_CRON || '0 10 * * *';
  cron.schedule(schedule, runReminders, {
    timezone: getJobTimezone(),
  });
  logger.info({ schedule, tz: getJobTimezone() }, '[ReminderJob] scheduled');
}

module.exports = { startReminderJob, runReminders };
