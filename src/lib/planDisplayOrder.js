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

module.exports = { PLAN_DISPLAY_ORDER, sortPlansByDisplayOrder };
