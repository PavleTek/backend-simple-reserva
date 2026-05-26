'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');
const {
  buildNotificationSettingsResponse,
  saveNotifySettings,
} = require('../services/reservationNotifyRecipients');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

async function getRestaurantContext(req) {
  const restaurantId = req.activeRestaurant.restaurantId;
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, isDeleted: false },
    select: { id: true, organizationId: true },
  });
  if (!restaurant) throw new ValidationError('Restaurante no encontrado');
  return { restaurantId: restaurant.id, organizationId: restaurant.organizationId };
}

router.get('/notification-settings', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { organizationId, restaurantId } = await getRestaurantContext(req);
    const payload = await buildNotificationSettingsResponse(organizationId, restaurantId);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.patch('/notification-settings', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { organizationId, restaurantId } = await getRestaurantContext(req);
    const { recipients, reservationNotifyOnWeb, reservationNotifyOnManual } = req.body;

    if (reservationNotifyOnWeb !== undefined && typeof reservationNotifyOnWeb !== 'boolean') {
      throw new ValidationError('reservationNotifyOnWeb debe ser booleano');
    }

    if (reservationNotifyOnManual !== undefined && typeof reservationNotifyOnManual !== 'boolean') {
      throw new ValidationError('reservationNotifyOnManual debe ser booleano');
    }

    try {
      const payload = await saveNotifySettings({
        organizationId,
        restaurantId,
        recipients,
        reservationNotifyOnWeb,
        reservationNotifyOnManual,
      });
      res.json(payload);
    } catch (err) {
      if (err.message === 'INVALID_RECIPIENTS') {
        throw new ValidationError('La lista de destinatarios no es válida');
      }
      if (err.message === 'NOTHING_TO_UPDATE') {
        throw new ValidationError('No hay campos para actualizar');
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
