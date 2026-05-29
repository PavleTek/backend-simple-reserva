'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { createRecoveryPaymentLink } = require('../services/billing/recoveryLinkService');

const CRON = process.env.LAST_CHANCE_LINK_CRON || '0 8 * * *';
const HOURS_BEFORE_EXPIRY = Number(process.env.LAST_CHANCE_HOURS_BEFORE_EXPIRY || 24);

async function runLastChanceLinkJob() {
  const threshold = new Date(Date.now() + HOURS_BEFORE_EXPIRY * 60 * 60 * 1000);

  const subs = await prisma.subscription.findMany({
    where: {
      status: 'grace',
      gracePeriodEndsAt: { lte: threshold, gt: new Date() },
      isActiveSubscription: true,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, email: true } },
        },
      },
    },
  });

  let sent = 0;
  for (const sub of subs) {
    const ownerId = sub.organization?.owner?.id;
    if (!ownerId) continue;

    const restaurant = await prisma.restaurant.findFirst({
      where: { organizationId: sub.organizationId, isDeleted: false },
      select: { id: true },
    });
    if (!restaurant) continue;

    try {
      const link = await createRecoveryPaymentLink({
        organizationId: sub.organizationId,
        userId: ownerId,
        restaurantId: restaurant.id,
      });

      const { sendEmail } = require('../services/emailService');
      const { billingUrl } = require('../utils/restaurantPanelUrl');
      const panelUrl = billingUrl();

      await sendEmail({
        fromEmail: process.env.RESEND_FROM_EMAIL || 'billing@simplereserva.cl',
        toEmails: [sub.organization.owner.email],
        subject: `Última oportunidad para regularizar tu pago — ${sub.organization.name}`,
        content: `<p>Tu acceso a SimpleReserva se suspenderá pronto. <a href="${link.paymentUrl}">Paga ahora</a> o visita <a href="${panelUrl}">facturación</a>.</p>`,
        isHtml: true,
      });
      sent += 1;
    } catch (err) {
      console.error('[lastChanceLinkJob]', sub.organizationId, err?.message);
    }
  }

  console.log('[lastChanceLinkJob] sent', sent);
  return { sent };
}

function startLastChanceLinkJob() {
  cron.schedule(CRON, () => {
    runLastChanceLinkJob().catch((err) => console.error('[lastChanceLinkJob]', err));
  }, { timezone: 'America/Santiago' });
  console.log('[lastChanceLinkJob] scheduled', CRON);
}

module.exports = { startLastChanceLinkJob, runLastChanceLinkJob };
