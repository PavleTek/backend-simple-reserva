'use strict';

const planService = require('../services/planService');
const { ForbiddenError } = require('../utils/errors');

async function requireActivitiesModulePlan(req, res, next) {
  try {
    const restaurantId = req.params.restaurantId;
    if (!restaurantId) {
      return next(new ForbiddenError('El módulo de Actividades no está disponible en tu plan'));
    }
    const allowed = await planService.canUseActivitiesModule(restaurantId);
    if (!allowed) {
      return next(
        new ForbiddenError(
          'El módulo de Actividades está disponible en el plan Premium. Actualiza tu plan en Facturación.'
        )
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireActivitiesModulePlan };
