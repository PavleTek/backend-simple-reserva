'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../utils/errors');

// Characters that are unambiguous when reading a code aloud or hand-typing it
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a random promo code string.
 * Uses crypto.randomBytes for uniform distribution across CODE_ALPHABET.
 * @param {number} length - default 10
 * @returns {string}
 */
function generateRandomCode(length = 10) {
  let code = '';
  const alphabetLen = CODE_ALPHABET.length;
  const randomBytes = crypto.randomBytes(length * 2); // overgenerate to handle modulo bias
  let byteIdx = 0;
  while (code.length < length) {
    const byte = randomBytes[byteIdx++];
    // Reject bytes that would introduce bias
    if (byte < Math.floor(256 / alphabetLen) * alphabetLen) {
      code += CODE_ALPHABET[byte % alphabetLen];
    }
    if (byteIdx >= randomBytes.length) {
      // Replenish if we somehow exhausted the buffer (very unlikely)
      const extra = crypto.randomBytes(length * 2);
      extra.copy(randomBytes);
      byteIdx = 0;
    }
  }
  return code;
}

/**
 * Generate a unique code, retrying on DB collision up to maxAttempts times.
 * @param {number} length
 * @param {number} maxAttempts
 * @param {object} [tx] - optional Prisma transaction client
 * @returns {Promise<string>}
 */
async function generateUniqueCode(length = 10, maxAttempts = 5, tx = null) {
  const client = tx || prisma;
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateRandomCode(length);
    const existing = await client.promoCode.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error('No se pudo generar un código único. Inténtalo de nuevo.');
}

/**
 * Compute when access ends based on a duration value + unit from a given start time.
 * @param {number} durationValue
 * @param {'days'|'months'} durationUnit
 * @param {Date} [from]
 * @returns {Date}
 */
function computeAccessEnd(durationValue, durationUnit, from = new Date()) {
  const d = new Date(from);
  if (durationUnit === 'months') {
    d.setMonth(d.getMonth() + durationValue);
  } else {
    d.setDate(d.getDate() + durationValue);
  }
  return d;
}

/**
 * Validate a promo code for use during signup.
 * Returns the promoCode record (with plan included) on success.
 * Throws ValidationError with a Spanish message on any failure.
 *
 * @param {object} options
 * @param {string} options.code
 * @param {string} options.email - the email being registered
 * @param {object} [options.tx] - optional Prisma transaction client (for atomic use)
 * @returns {Promise<{ promoCode: object }>}
 */
async function validatePromoCode({ code, email, tx = null }) {
  if (!code || !code.trim()) {
    throw new ValidationError('El código promocional no puede estar vacío.');
  }

  const client = tx || prisma;
  const now = new Date();

  const promoCode = await client.promoCode.findFirst({
    where: { code: { equals: code.trim(), mode: 'insensitive' } },
    include: { plan: true },
  });

  if (!promoCode) {
    throw new ValidationError('El código promocional no es válido.');
  }

  if (!promoCode.isActive) {
    throw new ValidationError('El código promocional no está activo.');
  }

  if (promoCode.expiresAt && promoCode.expiresAt <= now) {
    throw new ValidationError('El código promocional ha expirado.');
  }

  if (
    promoCode.maxRedemptions !== null &&
    promoCode.timesRedeemed >= promoCode.maxRedemptions
  ) {
    throw new ValidationError('El código promocional ya no tiene usos disponibles.');
  }

  if (
    promoCode.lockedToEmail &&
    promoCode.lockedToEmail.toLowerCase() !== email.toLowerCase().trim()
  ) {
    throw new ValidationError('Este código promocional no es válido para este correo electrónico.');
  }

  if (promoCode.type === 'signup_plan_grant') {
    if (!promoCode.planId || !promoCode.durationValue || !promoCode.durationUnit) {
      throw new ValidationError('El código promocional no está configurado correctamente.');
    }
    if (!promoCode.plan) {
      throw new ValidationError('El plan asociado al código promocional no existe.');
    }
    if (!['days', 'months'].includes(promoCode.durationUnit)) {
      throw new ValidationError('El código promocional tiene una duración inválida.');
    }
  }

  return { promoCode };
}

/**
 * Record a promo code redemption and increment timesRedeemed.
 * Must be called inside a Prisma transaction.
 *
 * @param {object} options
 * @param {object} options.promoCode - the validated PromoCode record
 * @param {string} options.userId
 * @param {string} options.organizationId
 * @param {object} options.tx - Prisma transaction client (required)
 * @returns {Promise<{ planAccessEndsAt: Date }>}
 */
async function redeemPromoCodeForSignup({ promoCode, userId, organizationId, tx }) {
  if (!tx) throw new Error('redeemPromoCodeForSignup requires a transaction client');

  const planAccessEndsAt = computeAccessEnd(promoCode.durationValue, promoCode.durationUnit);

  await tx.promoCode.update({
    where: { id: promoCode.id },
    data: { timesRedeemed: { increment: 1 } },
  });

  await tx.promoCodeRedemption.create({
    data: {
      promoCodeId: promoCode.id,
      userId,
      organizationId,
      planAccessEndsAt,
    },
  });

  return { planAccessEndsAt };
}

module.exports = {
  generateRandomCode,
  generateUniqueCode,
  computeAccessEnd,
  validatePromoCode,
  redeemPromoCodeForSignup,
};
