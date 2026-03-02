/**
 * Sends morning daily reservation summary to restaurant owners/admins.
 * Runs daily at 08:00 Chile time.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { sendDailySummary } = require('../services/notificationService');

const PANEL_BASE_URL = process.env.RESTAURANT_PANEL_URL || process.env.BOOKING_BASE_URL || 'http://localhost:5175';

function getTodayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start, end };
}

async function runDailySummary() {
  try {
  const { start, end } = getTodayRange();
  const restaurants = await prisma.restaurant.findMany({
    where: { isActive: true },
    include: {
      reservations: {
        where: {
          status: 'confirmed',
          dateTime: { gte: start, lte: end },
        },
        orderBy: { dateTime: 'asc' },
      },
      userRestaurants: {
        where: { role: { in: ['owner', 'admin'] } },
        include: { user: { select: { email: true } } },
      },
    },
  });

  let sent = 0;
  for (const rest of restaurants) {
    const count = rest.reservations.length;
    if (count === 0) continue;

    const firstTime = rest.reservations[0]
      ? new Date(rest.reservations[0].dateTime).toLocaleTimeString('es-CL', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
    const panelUrl = `${PANEL_BASE_URL.replace(/\/$/, '')}/reservations?date=${start.toISOString().split('T')[0]}`;

    const emails = [...new Set(rest.userRestaurants.map((ur) => ur.user.email).filter(Boolean))];
    for (const email of emails) {
      const ok = await sendDailySummary({
        email,
        restaurantName: rest.name,
        count,
        firstTime,
        panelUrl,
      });
      if (ok) sent++;
    }
  }

  console.log(`[DailySummaryJob] Sent ${sent} daily summaries`);
  } catch (err) {
    console.error('[DailySummaryJob] Error running daily summaries:', err);
  }
}

function startDailySummaryJob() {
  const schedule = process.env.DAILY_SUMMARY_CRON || '0 8 * * *';
  cron.schedule(schedule, runDailySummary, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log(`[DailySummaryJob] Scheduled: ${schedule} (${process.env.TZ || 'America/Santiago'})`);
}

module.exports = { startDailySummaryJob, runDailySummary };
