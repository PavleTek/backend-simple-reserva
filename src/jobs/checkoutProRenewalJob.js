/**
 * Envía recordatorio con link de renovación mensual para suscripciones Checkout Pro
 * (no tienen débito automático). Corre diario a las 10:00 hora Chile.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { sendEmail } = require('../services/emailService');
const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');
const { BILLING_STRATEGY_MANUAL } = require('../lib/billingDomain');

const RESTAURANT_PORTAL_URL = (process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175').replace(/\/$/, '');
const REMINDER_DAYS_BEFORE = Number(process.env.CHECKOUT_PRO_RENEWAL_DAYS_BEFORE || 3);

function msToDays(ms) {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function buildRenewalEmailHtml({ orgName, planName, checkoutUrl, periodEnd }) {
  const endStr = periodEnd
    ? new Date(periodEnd).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'pronto';
  return `
    <p>Hola,</p>
    <p>Tu suscripción a <strong>SimpleReserva</strong> (${orgName}) con pago por tarjeta vence el <strong>${endStr}</strong>.</p>
    <p>Para seguir usando el plan <strong>${planName}</strong>, renueva con este enlace (Mercado Pago, CLP):</p>
    <p><a href="${checkoutUrl}">Renovar suscripción</a></p>
    <p>Si ya pagaste, puedes ignorar este correo.</p>
    <p>— Equipo SimpleReserva</p>
  `;
}

async function runCheckoutProRenewalReminders() {
  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: {
      status: 'active',
      isActiveSubscription: true,
      billingStrategy: BILLING_STRATEGY_MANUAL,
      currentPeriodEnd: { not: null },
    },
    include: {
      plan: { select: { productSKU: true, name: true } },
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { email: true } },
          restaurants: { take: 1, select: { id: true } },
        },
      },
    },
  });

  let sent = 0;

  for (const sub of subs) {
    if (!sub.currentPeriodEnd) continue;
    const daysLeft = msToDays(new Date(sub.currentPeriodEnd).getTime() - now.getTime());
    if (daysLeft !== REMINDER_DAYS_BEFORE) continue;

    const restaurantId = sub.organization?.restaurants?.[0]?.id;
    if (!restaurantId) continue;

    const toEmail = sub.organization?.owner?.email;
    if (!toEmail) continue;

    try {
      const { checkoutUrl } = await mercadopagoCheckoutProService.createRenewalPreference({
        organizationId: sub.organizationId,
        planSKU: sub.plan.productSKU,
        subscriptionId: sub.id,
        restaurantId,
      });

      const billingUrl = `${RESTAURANT_PORTAL_URL}/billing?restaurantId=${restaurantId}`;
      const html = buildRenewalEmailHtml({
        orgName: sub.organization.name,
        planName: sub.plan.name,
        checkoutUrl,
        periodEnd: sub.currentPeriodEnd,
      });

      await sendEmail({
        fromEmail: 'noreply@simplereserva.com',
        toEmails: [toEmail],
        subject: `Renueva tu plan SimpleReserva antes del ${new Date(sub.currentPeriodEnd).toLocaleDateString('es-CL')}`,
        content: `${html}<p><small>También puedes ir a <a href="${billingUrl}">Facturación</a> en el panel.</small></p>`,
        isHtml: true,
      });
      sent++;
    } catch (err) {
      logger.error({ err, subscriptionId: sub.id }, '[CheckoutProRenewalJob] failed');
    }
  }

  if (sent > 0) {
    logger.info({ sent }, '[CheckoutProRenewalJob] renewal reminders sent');
  }
}

function startCheckoutProRenewalJob() {
  const schedule = process.env.CHECKOUT_PRO_RENEWAL_CRON || '0 10 * * *';
  cron.schedule(schedule, runCheckoutProRenewalReminders, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[CheckoutProRenewalJob] scheduled');
}

module.exports = { startCheckoutProRenewalJob, runCheckoutProRenewalReminders };
