'use strict';

const express = require('express');
const {
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles,
} = require('../middleware/authentication');
const { ROLES_OPERATIONAL } = require('../auth/roles');
const {
  getInsights,
  evaluateRestaurantWithLock,
  applyUserAction,
  recordEvents,
} = require('../services/insightEngine');
const { shouldEvaluateRestaurant } = require('../services/insightEngine/config');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(ROLES_OPERATIONAL));

/** GET — lectura pura */
router.get('/', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const data = await getInsights(restaurantId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/** POST /refresh — re-evalúa si stale, bajo lock distribuido */
router.post('/refresh', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    if (!shouldEvaluateRestaurant(restaurantId)) {
      const data = await getInsights(restaurantId);
      return res.json({ refreshed: false, ...data });
    }
    const result = await evaluateRestaurantWithLock(restaurantId);
    // En observación el panel no muestra; igual devolvemos lectura gated
    const data = await getInsights(restaurantId);
    res.json({
      refreshed: !result?.skipped,
      refreshResult: result,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id — acciones de usuario */
router.patch('/:id', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const { action, days } = req.body || {};
    const allowed = ['dismiss', 'snooze', 'action_taken', 'marked_useful'];
    if (!allowed.includes(action)) {
      return res.status(400).json({ error: 'Acción no válida' });
    }
    const updated = await applyUserAction(restaurantId, req.params.id, action, { days });
    res.json({
      id: updated.id,
      dismissedAt: updated.dismissedAt,
      snoozedUntil: updated.snoozedUntil,
      actionTakenAt: updated.actionTakenAt,
      markedUsefulAt: updated.markedUsefulAt,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

/** POST /events — impresiones / CTA / opened */
router.post('/events', async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    const events = req.body?.events || [];
    const result = await recordEvents(restaurantId, events);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
