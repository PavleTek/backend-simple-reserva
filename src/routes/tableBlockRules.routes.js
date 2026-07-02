'use strict';

/**
 * tableBlockRules.routes.js
 *
 * Reglas de bloqueo mesa→mesas: configuran qué otras mesas quedan bloqueadas
 * (no reservables) mientras una mesa "gatillo" tiene una reserva/hold activo.
 * Pensado para mesas de evento grandes que ocupan el espacio de varias mesas
 * físicas alrededor, pero funciona para cualquier par/grupo de mesas vinculadas.
 *
 * GET /api/restaurant/:restaurantId/tables/:tableId/block-rules
 * PUT /api/restaurant/:restaurantId/tables/:tableId/block-rules
 */

const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG, ROLES_CONFIG_VIEW } = require('../auth/roles');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { incrementDataVersion } = require('../utils/dataVersion');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

/** Resumen de todas las reglas del local (espacios de evento + mesas vinculadas). */
router.get(
  '/block-rules/summary',
  authenticateRestaurantRoles(ROLES_CONFIG_VIEW),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;

      const rules = await prisma.tableBlockRule.findMany({
        where: { restaurantId },
        include: {
          triggerTable: {
            select: {
              id: true,
              label: true,
              isActive: true,
              zone: { select: { name: true } },
            },
          },
          blockedTable: {
            select: {
              id: true,
              label: true,
              isActive: true,
              zone: { select: { name: true } },
            },
          },
        },
      });

      const activeRules = rules.filter(
        (r) => r.triggerTable.isActive && r.blockedTable.isActive,
      );

      /** @type {Map<string, { tableId: string, tableLabel: string, zoneName: string, blockedCount: number, minPartySize: number | null }>} */
      const triggerMap = new Map();
      /** @type {Map<string, { tableId: string, tableLabel: string, zoneName: string, triggers: Map<string, { tableId: string, tableLabel: string }> }>} */
      const tiedMap = new Map();

      for (const rule of activeRules) {
        const triggerId = rule.triggerTable.id;
        let trigger = triggerMap.get(triggerId);
        if (!trigger) {
          trigger = {
            tableId: triggerId,
            tableLabel: rule.triggerTable.label,
            zoneName: rule.triggerTable.zone.name,
            blockedCount: 0,
            minPartySize: rule.minPartySize,
          };
          triggerMap.set(triggerId, trigger);
        }
        trigger.blockedCount += 1;
        if (rule.minPartySize != null) {
          trigger.minPartySize = rule.minPartySize;
        }

        const blockedId = rule.blockedTable.id;
        let tied = tiedMap.get(blockedId);
        if (!tied) {
          tied = {
            tableId: blockedId,
            tableLabel: rule.blockedTable.label,
            zoneName: rule.blockedTable.zone.name,
            triggers: new Map(),
          };
          tiedMap.set(blockedId, tied);
        }
        tied.triggers.set(triggerId, {
          tableId: triggerId,
          tableLabel: rule.triggerTable.label,
        });
      }

      const triggers = [...triggerMap.values()].sort((a, b) =>
        a.tableLabel.localeCompare(b.tableLabel, 'es', { numeric: true }),
      );
      const tied = [...tiedMap.values()]
        .map((entry) => ({
          tableId: entry.tableId,
          tableLabel: entry.tableLabel,
          zoneName: entry.zoneName,
          triggers: [...entry.triggers.values()].sort((a, b) =>
            a.tableLabel.localeCompare(b.tableLabel, 'es', { numeric: true }),
          ),
        }))
        .sort((a, b) => a.tableLabel.localeCompare(b.tableLabel, 'es', { numeric: true }));

      res.json({ triggers, tied });
    } catch (error) {
      next(error);
    }
  },
);

async function loadOwnActiveTable(restaurantId, tableId) {
  const table = await prisma.restaurantTable.findUnique({
    where: { id: tableId },
    include: { zone: true },
  });
  if (!table || table.zone.restaurantId !== restaurantId || !table.isActive) {
    throw new NotFoundError('Mesa no encontrada');
  }
  return table;
}

router.get(
  '/:tableId/block-rules',
  authenticateRestaurantRoles(ROLES_CONFIG_VIEW),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      await loadOwnActiveTable(restaurantId, req.params.tableId);

      const rules = await prisma.tableBlockRule.findMany({
        where: { triggerTableId: req.params.tableId },
        include: { blockedTable: { select: { id: true, label: true, isActive: true } } },
      });

      const activeRules = rules.filter((r) => r.blockedTable.isActive);
      res.json({
        blockedTables: activeRules.map((r) => ({ id: r.blockedTable.id, label: r.blockedTable.label })),
        minPartySize: activeRules.length > 0 ? activeRules[0].minPartySize : null,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  '/:tableId/block-rules',
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const table = await loadOwnActiveTable(restaurantId, req.params.tableId);

      const { blockedTableIds, minPartySize } = req.body;
      if (!Array.isArray(blockedTableIds)) {
        throw new ValidationError('Se requiere blockedTableIds como array.');
      }
      if (blockedTableIds.some((id) => typeof id !== 'string')) {
        throw new ValidationError('blockedTableIds debe ser un array de ids.');
      }
      if (blockedTableIds.includes(table.id)) {
        throw new ValidationError('Una mesa no puede bloquearse a sí misma.');
      }

      const uniqueIds = [...new Set(blockedTableIds)];
      if (uniqueIds.length !== blockedTableIds.length) {
        throw new ValidationError('Hay mesas duplicadas en la lista.');
      }

      let normalizedMinPartySize = null;
      if (minPartySize !== undefined && minPartySize !== null && minPartySize !== '') {
        const n = Number(minPartySize);
        if (!Number.isFinite(n) || n < 1) {
          throw new ValidationError('minPartySize debe ser un número positivo.');
        }
        normalizedMinPartySize = Math.floor(n);
      }

      if (uniqueIds.length > 0) {
        const others = await prisma.restaurantTable.findMany({
          where: { id: { in: uniqueIds }, isActive: true, zone: { restaurantId } },
          select: { id: true },
        });
        if (others.length !== uniqueIds.length) {
          throw new ValidationError('Una o más mesas vinculadas no pertenecen a este local.');
        }
      }

      await prisma.$transaction([
        prisma.tableBlockRule.deleteMany({ where: { triggerTableId: table.id } }),
        ...(uniqueIds.length > 0
          ? [
              prisma.tableBlockRule.createMany({
                data: uniqueIds.map((blockedTableId) => ({
                  restaurantId,
                  triggerTableId: table.id,
                  blockedTableId,
                  minPartySize: normalizedMinPartySize,
                })),
              }),
            ]
          : []),
      ]);

      await incrementDataVersion(restaurantId);

      res.json({ ok: true, blockedTableIds: uniqueIds, minPartySize: normalizedMinPartySize });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
