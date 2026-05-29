'use strict';

const prisma = require('../lib/prisma');
const { getMercadoPagoAccessToken } = require('../lib/mercadopagoEnv');
const { persistPaymentMethodSnapshot } = require('../services/billing/paymentMethodSnapshot');

/**
 * Backfill lastPaymentMethod* desde último PaymentReceipt por org.
 */
async function backfillPaymentMethodSnapshots() {
  const subs = await prisma.subscription.findMany({
    where: {
      lastPaymentLastFour: null,
      mercadopagoPreapprovalId: { not: null },
    },
    take: 100,
  });

  let updated = 0;
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    console.warn('[backfillPaymentMethod] no access token');
    return { updated: 0 };
  }

  const { MercadoPagoConfig, Payment } = require('mercadopago');
  const client = new MercadoPagoConfig({ accessToken });
  const payment = new Payment(client);

  for (const sub of subs) {
    const receipt = await prisma.paymentReceipt.findFirst({
      where: { organizationId: sub.organizationId, mercadopagoPaymentId: { not: null } },
      orderBy: { paymentDate: 'desc' },
    });
    if (!receipt?.mercadopagoPaymentId) continue;
    try {
      const mpPayment = await payment.get({ id: receipt.mercadopagoPaymentId });
      await persistPaymentMethodSnapshot(sub.organizationId, mpPayment);
      updated += 1;
    } catch (err) {
      console.warn('[backfillPaymentMethod] skip', sub.id, err?.message);
    }
  }

  return { updated };
}

module.exports = { backfillPaymentMethodSnapshots };
