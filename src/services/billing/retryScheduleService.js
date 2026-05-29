'use strict';

const { getMercadoPagoAccessToken } = require('../../lib/mercadopagoEnv');

/**
 * Obtiene próximo reintento de cobro desde MP preapproval summarized.
 * @param {string} preapprovalId
 * @returns {Promise<{ nextRetryAt: string|null, lastChargedAt: string|null }|null>}
 */
async function fetchMpRetrySchedule(preapprovalId) {
  if (!preapprovalId) return null;
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) return null;

  try {
    const { MercadoPagoConfig, PreApproval } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });
    const preApproval = new PreApproval(client);
    const mpSub = await preApproval.get({ id: preapprovalId });
    const summarized = mpSub?.summarized || mpSub?.auto_recurring || {};
    const nextDate =
      summarized.next_payment_date ||
      summarized.next_charge_date ||
      mpSub?.next_payment_date ||
      null;
    const lastDate =
      summarized.last_charged_date ||
      summarized.last_charged ||
      null;
    return {
      nextRetryAt: nextDate ? new Date(nextDate).toISOString() : null,
      lastChargedAt: lastDate ? new Date(lastDate).toISOString() : null,
    };
  } catch (err) {
    console.warn('[retrySchedule] fetch failed:', err?.message);
    return null;
  }
}

module.exports = {
  fetchMpRetrySchedule,
};
