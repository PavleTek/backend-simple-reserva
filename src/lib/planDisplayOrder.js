/** Left → right / tier order: Básico, Profesional, Premium (not alphabetical by SKU). */
const PLAN_DISPLAY_ORDER = ['plan-basico', 'plan-profesional', 'plan-premium'];

function sortPlansByDisplayOrder(plans) {
  if (!Array.isArray(plans)) return plans;
  const rank = (sku) => {
    const i = PLAN_DISPLAY_ORDER.indexOf(sku);
    return i === -1 ? 999 : i;
  };
  return [...plans].sort((a, b) => rank(a.productSKU) - rank(b.productSKU));
}

function getStandardPlanTier(productSKU) {
  const index = PLAN_DISPLAY_ORDER.indexOf(productSKU);
  return index === -1 ? null : index;
}

/**
 * upgrade | downgrade | null (custom o mismo tier estándar → sin etiqueta de dirección)
 */
function resolvePlanChangeType(currentSku, targetSku) {
  const currentTier = getStandardPlanTier(currentSku);
  const targetTier = getStandardPlanTier(targetSku);
  if (currentTier === null || targetTier === null) return null;
  if (targetTier > currentTier) return 'upgrade';
  if (targetTier < currentTier) return 'downgrade';
  return null;
}

module.exports = {
  PLAN_DISPLAY_ORDER,
  sortPlansByDisplayOrder,
  getStandardPlanTier,
  resolvePlanChangeType,
};
