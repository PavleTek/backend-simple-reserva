/**
 * Sends trial reminder emails at day 7 and day 12.
 * Runs daily at 09:00 Chile time.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { sendEmail } = require('../services/emailService');
const { isTrialing } = require('../services/subscriptionService');
const planService = require('../services/planService');

const PANEL_BASE_URL = process.env.APP_URL || process.env.RESTAURANT_PANEL_URL || 'http://localhost:5175';

function formatPriceCLP(amount) {
  if (amount == null) return '$4,990 CLP';
  return `$${Number(amount).toLocaleString('es-CL')} CLP`;
}

function msToDays(ms) {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function runTrialReminders() {
  const restaurants = await prisma.restaurant.findMany({
    where: {
      trialEndsAt: { not: null },
      isActive: true,
    },
    include: {
      userRestaurants: {
        where: { role: 'owner' },
        include: { user: { select: { email: true, name: true } } },
      },
      _count: { select: { reservations: true } },
    },
  });

  let sent = 0;
  const now = new Date();

  for (const rest of restaurants) {
    const inTrial = await isTrialing(rest.id);
    if (!inTrial) continue;

    const trialEndsAt = rest.trialEndsAt;
    if (!trialEndsAt) continue;

    const daysLeft = msToDays(trialEndsAt.getTime() - now.getTime());
    if (daysLeft !== 7 && daysLeft !== 12) continue;

    const ownerId = rest.userRestaurants.find((ur) => ur.role === 'owner')?.userId;
    const planConfig = ownerId ? await planService.resolvePlanConfig(ownerId, true) : null;
    const priceStr = formatPriceCLP(planConfig?.biweeklyPriceCLP);

    const config = await prisma.configuration.findFirst();
    const fromSender = config?.recoveryEmailSenderId
      ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
      : null;
    const fromEmail = fromSender || 'noreply@simplereserva.com';

    const panelUrl = `${PANEL_BASE_URL.replace(/\/$/, '')}/billing`;
    const subject =
      daysLeft === 7
        ? `Te quedan 7 días de prueba en SimpleReserva`
        : `Tu prueba de SimpleReserva termina en 2 días`;

    const reservationCount = rest._count.reservations;
    const body =
      daysLeft === 7
        ? `Hola,\n\nTe quedan 7 días de prueba gratuita en SimpleReserva para ${rest.name}.\n\n${reservationCount > 0 ? `Hasta ahora has recibido ${reservationCount} reservas. ` : ''}Activa tu suscripción antes de que termine la prueba para seguir recibiendo reservas sin interrupciones.\n\nPrecio: ${priceStr} cada 2 semanas. Sin contrato.\n\nActivar suscripción: ${panelUrl}\n\nSaludos,\nEl equipo de SimpleReserva`
        : `Hola,\n\nTu prueba gratuita de SimpleReserva para ${rest.name} termina en 2 días.\n\nActiva tu suscripción para no perder acceso a tu página de reservas:\n\n${panelUrl}\n\nPrecio: ${priceStr} cada 2 semanas. IVA incluido. Cancela cuando quieras.\n\nSaludos,\nEl equipo de SimpleReserva`;

    const emails = [...new Set(rest.userRestaurants.map((ur) => ur.user.email).filter(Boolean))];
    for (const email of emails) {
      try {
        await sendEmail({
          fromEmail,
          toEmails: [email],
          subject,
          content: body,
          isHtml: false,
        });
        sent++;
      } catch (err) {
        console.error(`[TrialReminderJob] Failed to send to ${email}:`, err);
      }
    }
  }

  if (sent > 0) {
    console.log(`[TrialReminderJob] Sent ${sent} trial reminders`);
  }
}

function startTrialReminderJob() {
  const schedule = process.env.TRIAL_REMINDER_CRON || '0 9 * * *';
  cron.schedule(schedule, runTrialReminders, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  console.log(`[TrialReminderJob] Scheduled: ${schedule}`);
}

module.exports = { startTrialReminderJob, runTrialReminders };
