const prisma = require('../lib/prisma');

/**
 * Auditoría ligera de suscripción/cobros (soporte).
 * Los fallos de escritura no deben romper el flujo principal.
 */
async function logSubscriptionEvent({ organizationId, subscriptionId, source, action, meta }) {
  try {
    await prisma.subscriptionEvent.create({
      data: {
        organizationId,
        subscriptionId: subscriptionId ?? null,
        source: source || 'system',
        action: action || 'unknown',
        meta: meta ?? undefined,
      },
    });
  } catch (err) {
    console.warn('[subscriptionAudit] logSubscriptionEvent:', err?.message ?? err);
  }
}

module.exports = { logSubscriptionEvent };
