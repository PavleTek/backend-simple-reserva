const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { incrementDataVersion } = require('../utils/dataVersion');
const { validateNoOverlap, ALLOWED_FIXTURE_TYPES } = require('../lib/floorPlanUtils');

const router = express.Router({ mergeParams: true });
const ALLOWED_ROTATION = new Set([0, 90, 180, 270]);

router.use(authenticateToken);
router.use(authorizeRestaurant);

async function loadZone(zoneId, restaurantId) {
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
  if (!zone || zone.restaurantId !== restaurantId || !zone.isActive) {
    throw new NotFoundError('Zona no encontrada');
  }
  return zone;
}

router.put('/layout', authenticateRestaurantRoles(ROLES_CONFIG), async (req, res, next) => {
  try {
    const { fixtures } = req.body;
    if (!Array.isArray(fixtures)) {
      throw new ValidationError('Se requiere fixtures como array.');
    }

    const zone = await loadZone(req.params.zoneId, req.activeRestaurant.restaurantId);

    const parsed = fixtures.map((f, index) => {
      if (!f || typeof f.type !== 'string' || !ALLOWED_FIXTURE_TYPES.has(f.type)) {
        throw new ValidationError('Tipo de elemento no válido.');
      }
      const posX = Number(f.posX);
      const posY = Number(f.posY);
      if (!Number.isFinite(posX) || !Number.isFinite(posY)) {
        throw new ValidationError('Cada elemento debe tener posición en el plano.');
      }
      const width = f.width !== undefined ? Number(f.width) : 1;
      const height = f.height !== undefined ? Number(f.height) : 1;
      const rotation = f.rotation !== undefined ? Number(f.rotation) : 0;
      if (!Number.isFinite(width) || width < 1 || width > 20) {
        throw new ValidationError('Ancho de elemento no válido.');
      }
      if (!Number.isFinite(height) || height < 1 || height > 20) {
        throw new ValidationError('Alto de elemento no válido.');
      }
      if (!ALLOWED_ROTATION.has(rotation)) {
        throw new ValidationError('Rotación debe ser 0, 90, 180 u 270.');
      }
      const label =
        f.label === undefined || f.label === null ? null : String(f.label).trim().slice(0, 80) || null;
      return {
        id: typeof f.id === 'string' && f.id.length > 0 ? f.id : null,
        type: f.type,
        label,
        posX,
        posY,
        width,
        height,
        rotation,
        sortOrder: Number.isFinite(Number(f.sortOrder)) ? Number(f.sortOrder) : index,
      };
    });

    const tables = await prisma.restaurantTable.findMany({
      where: { zoneId: zone.id, isActive: true },
    });

    const check = validateNoOverlap(tables, zone.gridCols, zone.gridRows, parsed);
    if (!check.ok) {
      throw new ValidationError(check.message);
    }

    await prisma.$transaction(async (tx) => {
      await tx.zoneFixture.deleteMany({ where: { zoneId: zone.id } });
      if (parsed.length > 0) {
        await tx.zoneFixture.createMany({
          data: parsed.map((f) => ({
            zoneId: zone.id,
            type: f.type,
            label: f.label,
            posX: f.posX,
            posY: f.posY,
            width: f.width,
            height: f.height,
            rotation: f.rotation,
            sortOrder: f.sortOrder,
          })),
        });
      }
    });

    const saved = await prisma.zoneFixture.findMany({
      where: { zoneId: zone.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    await incrementDataVersion(req.activeRestaurant.restaurantId);
    res.json({ fixtures: saved });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
