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
  const organizations = await prisma.restaurantOrganization.findMany({
    where: {
      trialEndsAt: { not: null },
    },
    include: {
      owner: { select: { id: true, email: true, name: true } },
      restaurants: {
        select: {
          id: true,
          name: true,
          _count: { select: { reservations: true } },
        }
      }
    },
  });

  let sent = 0;
  const now = new Date();

  for (const org of organizations) {
    const inTrial = await isTrialing(org.id);
    if (!inTrial) continue;

    const trialEndsAt = org.trialEndsAt;
    if (!trialEndsAt) continue;

    const daysLeft = msToDays(trialEndsAt.getTime() - now.getTime());
    if (daysLeft !== 7 && daysLeft !== 12) continue;

    const ownerId = org.ownerId;
    const planConfig = ownerId ? await planService.resolvePlanConfig(ownerId, true) : null;
    const priceStr = formatPriceCLP(planConfig?.priceCLP);

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

    // If multiple restaurants, we use the first one for the name in the email, or just the organization name
    const restaurantName = org.restaurants[0]?.name || org.name;
    const reservationCount = org.restaurants.reduce((acc, r) => acc + r._count.reservations, 0);
    
    const body =
      daysLeft === 7
        ? `Hola,\n\nTe quedan 7 días de prueba gratuita en SimpleReserva para ${restaurantName}.\n\n${reservationCount > 0 ? `Hasta ahora has recibido ${reservationCount} reservas. ` : ''}Activa tu suscripción antes de que termine la prueba para seguir recibiendo reservas sin interrupciones.\n\nPrecio: ${priceStr} cada mes. Sin contrato.\n\nActivar suscripción: ${panelUrl}\n\nSaludos,\nEl equipo de SimpleReserva`
        : `Hola,\n\nTu prueba gratuita de SimpleReserva para ${restaurantName} termina en 2 días.\n\nActiva tu suscripción para no perder acceso a tu página de reservas:\n\n${panelUrl}\n\nPrecio: ${priceStr} cada mes. IVA incluido. Cancela cuando quieras.\n\nSaludos,\nEl equipo de SimpleReserva`;

    const email = org.owner?.email;
    if (email) {
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
