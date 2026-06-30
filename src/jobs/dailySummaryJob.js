/**
 * Sends morning daily reservation summary to restaurant team (notification prefs).
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
const { buildNotificationSettingsResponse } = require('../services/reservationNotifyRecipients');

function getJobTimezone() {
  return process.env.TZ || 'America/Santiago';
}

async function runDailySummary() {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: { isActive: true, isDeleted: false },
      include: {
        organization: {
          select: {
            id: true,
            owner: { select: { email: true, country: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const rest of restaurants) {
      const organizationId = rest.organizationId;
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
          notes: true,
          table: { select: { label: true } },
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
        timezone,
      );

      const reservationItems = reservations.map((r) => ({
        time: formatTime(new Date(r.dateTime), timezone),
        partySize: r.partySize,
        customerName: r.customerName,
        tableLabel: r.table?.label ?? null,
        notes: r.notes ?? null,
      }));

      let activeRecipients = [];
      try {
        const settings = await buildNotificationSettingsResponse(organizationId, rest.id);
        activeRecipients = settings.activeRecipients || [];
      } catch (err) {
        logger.warn(
          { err, restaurantId: rest.id, organizationId },
          '[DailySummaryJob] could not load notification recipients',
        );
      }

      if (activeRecipients.length === 0) continue;

      for (const recipient of activeRecipients) {
        const ok = await sendDailySummary({
          email: recipient.email,
          recipientName: recipient.name,
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
