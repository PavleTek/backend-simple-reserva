'use strict';

const prisma = require('../../lib/prisma');

/**
 * Registra evento de analytics de cancelación (Mixpanel-ready).
 */
async function trackCancellationAnalytics({ organizationId, reason, reasonDetail, offeredDowngrade, acceptedRetention }) {
  const row = await prisma.subscriptionCancellation.create({
    data: {
      organizationId,
      reason: reason || null,
      reasonDetail: reasonDetail || null,
      offeredDowngrade: !!offeredDowngrade,
      acceptedRetention: !!acceptedRetention,
    },
  });

  if (process.env.MIXPANEL_TOKEN && process.env.BILLING_CANCEL_ANALYTICS_ENABLED === 'true') {
    console.log('[cancel-analytics]', {
      event: 'subscription_cancel_reason',
      organizationId,
      reason,
      offeredDowngrade,
      acceptedRetention,
      id: row.id,
    });
  }

  return row;
}

module.exports = { trackCancellationAnalytics };
