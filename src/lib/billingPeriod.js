/**
 * Cálculo de fin de periodo de facturación (alineado con periodicidad del plan).
 * Usado en billing, Mercado Pago y jobs de reconciliación.
 */

/**
 * @param {Date} startDate
 * @param {{ billingFrequency?: number, billingFrequencyType?: string }} planConfig
 * @returns {Date|null}
 */
function computePeriodEnd(startDate, planConfig) {
  if (!startDate || !planConfig) return null;
  const freq = planConfig.billingFrequency ?? 1;
  const type = planConfig.billingFrequencyType ?? 'months';
  const now = new Date();
  const next = new Date(startDate);
  if (next > now) return next;
  const maxIterations = 120;
  for (let i = 0; i < maxIterations && next <= now; i += 1) {
    if (type === 'months') {
      next.setMonth(next.getMonth() + freq);
    } else if (type === 'weeks') {
      next.setDate(next.getDate() + freq * 7);
    } else if (type === 'days') {
      next.setDate(next.getDate() + freq);
    } else if (type === 'yearly') {
      next.setFullYear(next.getFullYear() + freq);
    } else {
      break;
    }
  }
  return next;
}

/**
 * @param {{ startDate?: Date|null, status?: string }} subscriptionRow
 * @param {object} planConfig
 * @returns {string|null}
 */
function estimateNextPaymentDate(subscriptionRow, planConfig) {
  if (!subscriptionRow || subscriptionRow.status !== 'active' || !planConfig) return null;
  const end = computePeriodEnd(subscriptionRow.startDate, planConfig);
  return end ? end.toISOString() : null;
}

module.exports = {
  computePeriodEnd,
  estimateNextPaymentDate,
};
