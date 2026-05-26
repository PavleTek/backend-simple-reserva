'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

const AUDIENCES = ['owner', 'managers', 'hosts', 'all', 'custom'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOTIFY_SELECT = {
  reservationNotifyAudience: true,
  reservationNotifyCustomEmail: true,
  reservationNotifyOnWeb: true,
  reservationNotifyOnManual: true,
};

router.get('/notification-settings', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { organizationId } = req.activeRestaurant;
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: NOTIFY_SELECT,
    });
    if (!org) throw new ValidationError('Organización no encontrada');
    res.json(org);
  } catch (err) {
    next(err);
  }
});

router.patch('/notification-settings', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { organizationId } = req.activeRestaurant;
    const {
      reservationNotifyAudience,
      reservationNotifyCustomEmail,
      reservationNotifyOnWeb,
      reservationNotifyOnManual,
    } = req.body;

    const data = {};

    if (reservationNotifyAudience !== undefined) {
      if (!AUDIENCES.includes(reservationNotifyAudience)) {
        throw new ValidationError('Audiencia de notificación no válida');
      }
      data.reservationNotifyAudience = reservationNotifyAudience;
    }

    if (reservationNotifyCustomEmail !== undefined) {
      if (reservationNotifyCustomEmail === null || reservationNotifyCustomEmail === '') {
        data.reservationNotifyCustomEmail = null;
      } else if (typeof reservationNotifyCustomEmail !== 'string' || !EMAIL_REGEX.test(reservationNotifyCustomEmail.trim())) {
        throw new ValidationError('El correo personalizado no tiene un formato válido');
      } else {
        data.reservationNotifyCustomEmail = reservationNotifyCustomEmail.trim().toLowerCase();
      }
    }

    if (reservationNotifyOnWeb !== undefined) {
      if (typeof reservationNotifyOnWeb !== 'boolean') {
        throw new ValidationError('reservationNotifyOnWeb debe ser booleano');
      }
      data.reservationNotifyOnWeb = reservationNotifyOnWeb;
    }

    if (reservationNotifyOnManual !== undefined) {
      if (typeof reservationNotifyOnManual !== 'boolean') {
        throw new ValidationError('reservationNotifyOnManual debe ser booleano');
      }
      data.reservationNotifyOnManual = reservationNotifyOnManual;
    }

    if (Object.keys(data).length === 0) {
      throw new ValidationError('No hay campos para actualizar');
    }

    const orgCurrent = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: NOTIFY_SELECT,
    });
    if (!orgCurrent) throw new ValidationError('Organización no encontrada');

    const nextAudience = data.reservationNotifyAudience ?? orgCurrent.reservationNotifyAudience;
    const nextCustom =
      data.reservationNotifyCustomEmail !== undefined
        ? data.reservationNotifyCustomEmail
        : orgCurrent.reservationNotifyCustomEmail;

    if (nextAudience === 'custom' && !nextCustom) {
      throw new ValidationError('Debes indicar un correo cuando la audiencia es personalizada');
    }

    const org = await prisma.restaurantOrganization.update({
      where: { id: organizationId },
      data,
      select: NOTIFY_SELECT,
    });

    res.json(org);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
