'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG, ROLES_CONFIG_VIEW } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');
const { timeToMinutes, wrapWindow } = require('../services/slotEngine/windows');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

function validateTimeSpan(startTime, endTime, endsNextDay, label) {
  if (!/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) {
    throw new ValidationError(`${label}: formato HH:mm inválido`);
  }
  const open = timeToMinutes(startTime);
  const close = timeToMinutes(endTime);
  const span = endsNextDay ? close + 1440 - open : close - open;
  if (span <= 0) {
    throw new ValidationError(`${label}: la duración debe ser positiva`);
  }
  if (span > 24 * 60) {
    throw new ValidationError(`${label}: no puede superar 24 horas`);
  }
}

router.get('/settings', authenticateRestaurantRoles(ROLES_CONFIG_VIEW), async (req, res, next) => {
  try {
    const { restaurantId } = req.activeRestaurant;
    const [restaurant, windows] = await Promise.all([
      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          bookingAcceptanceMode: true,
          bookingClosedFallback: true,
          bookingClosedMessage: true,
          bookingContactPhone: true,
          bookingContactWhatsapp: true,
          bookingContactEmail: true,
        },
      }),
      prisma.bookingAcceptanceWindow.findMany({
        where: { restaurantId },
        orderBy: { dayOfWeek: 'asc' },
      }),
    ]);
    res.json({ ...restaurant, windows });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { restaurantId } = req.activeRestaurant;
    const {
      bookingAcceptanceMode,
      bookingClosedFallback,
      bookingClosedMessage,
      bookingContactPhone,
      bookingContactWhatsapp,
      bookingContactEmail,
      windows,
    } = req.body;

    const modes = ['ALWAYS_24_7', 'DURING_OPERATIONAL', 'CUSTOM'];
    if (bookingAcceptanceMode !== undefined && !modes.includes(bookingAcceptanceMode)) {
      throw new ValidationError('Modo de aceptación no válido');
    }

    const fallbacks = ['DISABLE', 'MESSAGE', 'CONTACT'];
    if (bookingClosedFallback !== undefined && !fallbacks.includes(bookingClosedFallback)) {
      throw new ValidationError('Fallback no válido');
    }

    if (Array.isArray(windows) && bookingAcceptanceMode === 'CUSTOM') {
      for (const w of windows) {
        if (w.dayOfWeek < 0 || w.dayOfWeek > 6) {
          throw new ValidationError('dayOfWeek debe ser 0–6');
        }
        validateTimeSpan(w.startTime, w.endTime, !!w.endsNextDay, `Día ${w.dayOfWeek}`);
        const wrapped = wrapWindow(
          timeToMinutes(w.startTime),
          timeToMinutes(w.endTime),
          !!w.endsNextDay,
        );
        if (!wrapped) throw new ValidationError(`Ventana inválida día ${w.dayOfWeek}`);
      }
    }

    await prisma.$transaction(async (tx) => {
      const data = {};
      if (bookingAcceptanceMode !== undefined) data.bookingAcceptanceMode = bookingAcceptanceMode;
      if (bookingClosedFallback !== undefined) data.bookingClosedFallback = bookingClosedFallback;
      if (bookingClosedMessage !== undefined) data.bookingClosedMessage = bookingClosedMessage || null;
      if (bookingContactPhone !== undefined) data.bookingContactPhone = bookingContactPhone || null;
      if (bookingContactWhatsapp !== undefined) data.bookingContactWhatsapp = bookingContactWhatsapp || null;
      if (bookingContactEmail !== undefined) data.bookingContactEmail = bookingContactEmail || null;
      if (Object.keys(data).length > 0) {
        await tx.restaurant.update({ where: { id: restaurantId }, data });
      }

      if (Array.isArray(windows)) {
        await tx.bookingAcceptanceWindow.deleteMany({ where: { restaurantId } });
        if (windows.length > 0) {
          await tx.bookingAcceptanceWindow.createMany({
            data: windows.map((w) => ({
              restaurantId,
              dayOfWeek: Number(w.dayOfWeek),
              startTime: w.startTime,
              endTime: w.endTime,
              endsNextDay: !!w.endsNextDay,
              isActive: w.isActive !== false,
            })),
          });
        }
      }
    });

    const [restaurant, updatedWindows] = await Promise.all([
      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          bookingAcceptanceMode: true,
          bookingClosedFallback: true,
          bookingClosedMessage: true,
          bookingContactPhone: true,
          bookingContactWhatsapp: true,
          bookingContactEmail: true,
        },
      }),
      prisma.bookingAcceptanceWindow.findMany({
        where: { restaurantId },
        orderBy: { dayOfWeek: 'asc' },
      }),
    ]);

    res.json({ ...restaurant, windows: updatedWindows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
