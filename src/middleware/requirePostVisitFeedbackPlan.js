'use strict';

const planService = require('../services/planService');
const { ForbiddenError } = require('../utils/errors');

async function requirePostVisitFeedbackPlan(req, res, next) {
  try {
    const restaurantId = req.params.restaurantId;
    if (!restaurantId) {
      return next(new ForbiddenError('Experiencia post-visita no disponible en tu plan'));
    }
    const allowed = await planService.canUsePostVisitFeedback(restaurantId);
    if (!allowed) {
      return next(
        new ForbiddenError(
          'Experiencia post-visita está disponible en planes Profesional y Premium. Actualiza tu plan en Facturación.'
        )
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requirePostVisitFeedbackPlan };
