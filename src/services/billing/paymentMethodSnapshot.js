'use strict';

const prisma = require('../../lib/prisma');

/**
 * Extrae snapshot de método de pago desde respuesta MP Payment API.
 * @param {object} mpPayment
 * @returns {object|null}
 */
function extractPaymentMethodFromMpPayment(mpPayment) {
  if (!mpPayment) return null;
  const card = mpPayment.card || mpPayment.payment_method?.data || {};
  const lastFour =
    card.last_four_digits ||
    card.last4 ||
    mpPayment.card?.last_four_digits ||
    null;
  const brand =
    mpPayment.payment_method_id ||
    card.cardholder?.name ||
    card.payment_method?.id ||
    null;
  if (!lastFour && !brand && !mpPayment.payment_type_id) return null;
  return {
    lastPaymentMethodKind: mpPayment.payment_type_id || null,
    lastPaymentMethodBrand: String(brand || '').toLowerCase() || null,
    lastPaymentLastFour: lastFour ? String(lastFour) : null,
    lastPaymentExpirationMonth: card.expiration_month ? Number(card.expiration_month) : null,
    lastPaymentExpirationYear: card.expiration_year ? Number(card.expiration_year) : null,
    lastPaymentAt: mpPayment.date_approved ? new Date(mpPayment.date_approved) : new Date(),
  };
}

/**
 * Persiste snapshot en la suscripción activa/grace de la org.
 */
async function persistPaymentMethodSnapshot(organizationId, mpPayment) {
  const snapshot = extractPaymentMethodFromMpPayment(mpPayment);
  if (!snapshot) return null;

  const sub = await prisma.subscription.findFirst({
    where: {
      organizationId,
      status: { in: ['active', 'grace', 'cancelled'] },
      isActiveSubscription: true,
    },
    orderBy: { startDate: 'desc' },
  });
  if (!sub) return null;

  return prisma.subscription.update({
    where: { id: sub.id },
    data: snapshot,
  });
}

/**
 * Formato amigable para API/UI.
 */
function formatPaymentMethodForApi(sub) {
  if (!sub) {
    return {
      kind: null,
      brand: null,
      lastFour: null,
      label: null,
      isManual: false,
      updatedAt: null,
    };
  }
  const isManual = sub.paymentProvider === 'mp_checkout_pro';
  if (isManual && !sub.lastPaymentLastFour) {
    return {
      kind: 'manual',
      brand: null,
      lastFour: null,
      label: null,
      isManual: true,
      updatedAt: sub.lastPaymentAt?.toISOString?.() ?? null,
    };
  }
  if (!sub.lastPaymentLastFour && !sub.lastPaymentMethodBrand) {
    return {
      kind: sub.paymentProvider === 'mercadopago_preapproval' ? 'auto' : 'manual',
      brand: null,
      lastFour: null,
      label: null,
      isManual: sub.paymentProvider === 'mp_checkout_pro',
      updatedAt: null,
    };
  }
  const brandLabel = (sub.lastPaymentMethodBrand || 'tarjeta').toUpperCase();
  const lastFour = sub.lastPaymentLastFour || '****';
  return {
    kind: sub.lastPaymentMethodKind,
    brand: sub.lastPaymentMethodBrand,
    lastFour: sub.lastPaymentLastFour,
    label: `${brandLabel} ●●●● ${lastFour}`,
    isManual: isManual,
    updatedAt: sub.lastPaymentAt?.toISOString?.() ?? null,
  };
}

module.exports = {
  extractPaymentMethodFromMpPayment,
  persistPaymentMethodSnapshot,
  formatPaymentMethodForApi,
};
