'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');

function formatUserDisplayName(user) {
  if (!user) return 'Equipo del local';
  const parts = [user.name, user.lastName].filter((p) => p?.trim());
  if (parts.length) return parts.join(' ').trim();
  return user.email || 'Equipo del local';
}

function formatRecoveryResolution(alert) {
  if (!alert?.resolutionNote || alert.status !== 'resolved') return null;
  return {
    note: alert.resolutionNote,
    resolvedAt: alert.resolvedAt ? new Date(alert.resolvedAt).toISOString() : null,
    resolvedByName: alert.resolvedByDisplayName || 'Equipo del local',
  };
}

/**
 * @param {string} restaurantId
 * @param {string[]} reservationIds
 * @returns {Promise<Map<string, { note: string, resolvedAt: string|null, resolvedByName: string }>>}
 */
async function getResolvedAlertsByReservationId(restaurantId, reservationIds) {
  const ids = [...new Set(reservationIds.filter(Boolean))];
  const map = new Map();
  if (ids.length === 0) return map;

  const alerts = await prisma.feedbackAlert.findMany({
    where: {
      restaurantId,
      status: 'resolved',
      feedbackResponse: {
        feedbackRequest: { reservationId: { in: ids } },
      },
    },
    orderBy: { resolvedAt: 'desc' },
    select: {
      status: true,
      resolutionNote: true,
      resolvedAt: true,
      resolvedByDisplayName: true,
      feedbackResponse: {
        select: { feedbackRequest: { select: { reservationId: true } } },
      },
    },
  });

  for (const alert of alerts) {
    const reservationId = alert.feedbackResponse?.feedbackRequest?.reservationId;
    if (!reservationId || map.has(reservationId)) continue;
    const formatted = formatRecoveryResolution(alert);
    if (formatted) map.set(reservationId, formatted);
  }
  return map;
}

/**
 * @param {object} params
 * @param {string} params.alertId
 * @param {string} params.restaurantId
 * @param {object|null|undefined} params.user
 * @param {string} params.resolutionNote
 */
async function resolveFeedbackAlert({ alertId, restaurantId, user, resolutionNote }) {
  const note = typeof resolutionNote === 'string' ? resolutionNote.trim() : '';
  if (note.length < 3) {
    throw new ValidationError('Indica qué hiciste para resolver el caso (mínimo 3 caracteres).');
  }
  if (note.length > 2000) {
    throw new ValidationError('La nota no puede superar 2000 caracteres.');
  }

  const alert = await prisma.feedbackAlert.findFirst({
    where: { id: alertId, restaurantId },
  });
  if (!alert) throw new NotFoundError('Alerta no encontrada');
  if (alert.status === 'resolved') {
    throw new ValidationError('Esta alerta ya fue resuelta.');
  }

  return prisma.feedbackAlert.update({
    where: { id: alert.id },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedByUserId: user?.id ?? null,
      resolvedByDisplayName: formatUserDisplayName(user),
      resolutionNote: note,
    },
  });
}

module.exports = {
  formatUserDisplayName,
  formatRecoveryResolution,
  getResolvedAlertsByReservationId,
  resolveFeedbackAlert,
};
