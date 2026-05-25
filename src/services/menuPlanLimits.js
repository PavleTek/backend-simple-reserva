const { ForbiddenError } = require('../utils/errors');

/** Plan Básico: 1 carta; Profesional/Premium: 3 (PDF + enlaces combinados). */
function getMaxMenus(planConfig) {
  if (planConfig && planConfig.multipleMenu === true) return 3;
  return 1;
}

function assertCanAddMenu(currentCount, planConfig) {
  const max = getMaxMenus(planConfig);
  if (currentCount >= max) {
    const msg =
      max === 1
        ? 'Tu plan actual permite una sola carta. Actualiza tu plan para agregar más.'
        : `Tu plan actual permite hasta ${max} cartas. Elimina una carta o actualiza tu plan.`;
    throw new ForbiddenError(msg);
  }
}

module.exports = { getMaxMenus, assertCanAddMenu };
