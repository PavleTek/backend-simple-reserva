/**
 * Sends morning daily reservation summary to restaurant owners/admins.
 * Runs daily at 08:00 Chile time.
 */

const cron = require('node-cron');
const { DateTime } = require('luxon');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { sendDailySummary } = require('../services/notificationService');
const { formatTime, formatDateDisplay } = require('../utils/dateFormat');
const { getEffectiveTimezone } = require('../utils/timezone');
const { buildReservationDayWhere } = require('../utils/reservationDateFilter');
const { reservationsListUrl } = require('../utils/restaurantPanelUrl');

/**
 * Fecha calendario "hoy" en la TZ del job (America/Santiago por defecto).
 * El resumen se arma por restaurante usando la TZ efectiva de cada local.
 */
function getJobTimezone() {
  return process.env.TZ || 'America/Santiago';
}

async function runDailySummary() {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: { isActive: true, isDeleted: false },
      include: {
        organization: {
          include: {
            owner: { select: { email: true, country: true } },
            managers: {
              include: { user: { select: { email: true } } },
            },
          },
        },
      },
    });

    let sent = 0;
    for (const rest of restaurants) {
      const ownerCountry = rest.organization?.owner?.country || 'CL';
      const timezone = getEffectiveTimezone(rest, ownerCountry);
      const todayYmd = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');

      const reservations = await prisma.reservation.findMany({
        where: buildReservationDayWhere(rest.id, todayYmd, timezone, {
          status: 'confirmed',
        }),
        orderBy: { dateTime: 'asc' },
        select: {
          dateTime: true,
          partySize: true,
          customerName: true,
        },
      });

      const count = reservations.length;
      if (count === 0) continue;

      const firstTime = reservations[0]
        ? formatTime(new Date(reservations[0].dateTime), timezone)
        : null;

      const panelUrl = reservationsListUrl({ date: todayYmd });
      const dateDisplay = formatDateDisplay(
        DateTime.fromISO(todayYmd, { zone: timezone }).toJSDate(),
        timezone
      );

      const reservationItems = reservations.map((r) => ({
        time: formatTime(new Date(r.dateTime), timezone),
        partySize: r.partySize,
        customerName: r.customerName,
      }));

      const emails = new Set();
      if (rest.organization?.owner?.email) {
        emails.add(rest.organization.owner.email);
      }
      if (rest.organization?.managers) {
        rest.organization.managers.forEach((m) => {
          if (m.user?.email) emails.add(m.user.email);
        });
      }

      for (const email of emails) {
        const ok = await sendDailySummary({
          email,
          restaurantName: rest.name,
          count,
          firstTime,
          dateDisplay,
          panelUrl,
          reservations: reservationItems,
        });
        if (ok) sent++;
      }
    }

    logger.info({ sent, jobTz: getJobTimezone() }, '[DailySummaryJob] daily summaries sent');
  } catch (err) {
    logger.error({ err }, '[DailySummaryJob] failed');
  }
}

function startDailySummaryJob() {
  const schedule = process.env.DAILY_SUMMARY_CRON || '0 8 * * *';
  cron.schedule(schedule, runDailySummary, {
    timezone: getJobTimezone(),
  });
  logger.info({ schedule, tz: getJobTimezone() }, '[DailySummaryJob] scheduled');
}

module.exports = { startDailySummaryJob, runDailySummary };
