const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');
const r2Service = require('../services/r2Service');
const planService = require('../services/planService');
const { compressPdfBuffer } = require('../services/pdfCompressionService');
const { assertCanAddMenu } = require('../services/menuPlanLimits');
const {
  resolvePublicPdfUrl,
  getNextSortOrder,
  deleteMenuR2IfPdf,
  parseMenuTypeParam,
} = require('../services/menuService');
const {
  normalizeExternalUrl,
  validateMenuLabel,
  LEGACY_MENU_TYPES,
  legacyLabelForMenuType,
  legacySortOrderForMenuType,
} = require('../utils/menuUrlValidation');

const router = express.Router({ mergeParams: true });

const MAX_MENU_PDF_BYTES = 50 * 1024 * 1024;
const MAX_MENU_PDF_MB = 50;

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new ValidationError('Solo se permiten archivos PDF'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_MENU_PDF_BYTES },
});

function uploadMenuPdf(req, res, next) {
  upload.single('menu')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new ValidationError(
            `El archivo supera el tamaño máximo permitido (${MAX_MENU_PDF_MB} MB).`
          )
        );
      }
      return next(err);
    }
    next();
  });
}

async function countMenus(restaurantId) {
  return prisma.restaurantMenu.count({ where: { restaurantId } });
}

async function uploadPdfToR2(restaurantId, menuId, buffer, mimetype, originalname) {
  const { buffer: uploadBuffer } = await compressPdfBuffer(buffer);
  if (uploadBuffer.length > MAX_MENU_PDF_BYTES) {
    throw new ValidationError(
      `El PDF sigue siendo demasiado grande después de optimizarlo (máx. ${MAX_MENU_PDF_MB} MB). ` +
        'Prueba comprimirlo con otra herramienta o reducir las imágenes del documento.'
    );
  }
  const timestamp = Date.now();
  const r2Key = `menus/${restaurantId}/${menuId}-${timestamp}.pdf`;
  await r2Service.uploadFile(r2Key, uploadBuffer, mimetype);
  const url = resolvePublicPdfUrl(restaurantId, menuId, r2Key);
  return {
    fileName: originalname,
    fileSize: uploadBuffer.length,
    r2Key,
    url,
  };
}

/**
 * GET /api/restaurant/:restaurantId/menus
 */
router.get(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const menus = await prisma.restaurantMenu.findMany({
        where: { restaurantId: req.activeRestaurant.restaurantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      res.json(menus);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/restaurant/:restaurantId/menus/reorder
 */
router.post(
  '/reorder',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        throw new ValidationError('orderedIds debe ser un arreglo no vacío');
      }
      const existing = await prisma.restaurantMenu.findMany({
        where: { restaurantId },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((m) => m.id));
      if (orderedIds.length !== existingIds.size || orderedIds.some((id) => !existingIds.has(id))) {
        throw new ValidationError('La lista de orden no coincide con las cartas del restaurante');
      }
      await prisma.$transaction(
        orderedIds.map((id, index) =>
          prisma.restaurantMenu.update({
            where: { id },
            data: { sortOrder: index },
          })
        )
      );
      const menus = await prisma.restaurantMenu.findMany({
        where: { restaurantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      res.json(menus);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/restaurant/:restaurantId/menus
 * JSON: { type: 'link', label, externalUrl } | multipart PDF: label + menu file
 */
router.post(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  uploadMenuPdf,
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const config = await planService.resolvePlanConfigForRestaurant(restaurantId);
      const total = await countMenus(restaurantId);
      assertCanAddMenu(total, config);

      const contentType = req.headers['content-type'] || '';
      const isMultipart = contentType.includes('multipart/form-data');

      if (isMultipart || req.file) {
        if (!req.file) {
          throw new ValidationError('No se subió ningún archivo PDF');
        }
        const label = validateMenuLabel(req.body?.label);
        const sortOrder =
          req.body?.sortOrder != null ? parseInt(req.body.sortOrder, 10) : await getNextSortOrder(restaurantId);

        const created = await prisma.restaurantMenu.create({
          data: {
            restaurantId,
            type: 'pdf',
            label,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : await getNextSortOrder(restaurantId),
            visible: true,
            url: '', // placeholder until R2 upload
          },
        });

        const pdfMeta = await uploadPdfToR2(
          restaurantId,
          created.id,
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );

        const menu = await prisma.restaurantMenu.update({
          where: { id: created.id },
          data: pdfMeta,
        });
        return res.status(201).json(menu);
      }

      const type = parseMenuTypeParam(req.body?.type);
      if (type !== 'link') {
        throw new ValidationError('Para subir PDF usa multipart con el archivo en el campo menu');
      }

      const label = validateMenuLabel(req.body?.label);
      const externalUrl = normalizeExternalUrl(req.body?.externalUrl);
      const sortOrder =
        req.body?.sortOrder != null
          ? parseInt(req.body.sortOrder, 10)
          : await getNextSortOrder(restaurantId);

      const menu = await prisma.restaurantMenu.create({
        data: {
          restaurantId,
          type: 'link',
          label,
          sortOrder: Number.isFinite(sortOrder) ? sortOrder : await getNextSortOrder(restaurantId),
          visible: true,
          url: externalUrl,
          externalUrl,
        },
      });
      return res.status(201).json(menu);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Legacy: POST /api/restaurant/:restaurantId/menus/:menuType (main|drinks|dessert)
 * Registered before /:menuId so DELETE/POST by menuType keep working.
 */
router.post(
  '/:menuType',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  uploadMenuPdf,
  async (req, res, next) => {
    try {
      const { menuType } = req.params;
      if (!LEGACY_MENU_TYPES.includes(menuType)) {
        return next();
      }

      const { restaurantId } = req.activeRestaurant;
      if (!req.file) {
        throw new ValidationError('No se subió ningún archivo');
      }

      const config = await planService.resolvePlanConfigForRestaurant(restaurantId);
      const hasMultipleMenu = config && config.multipleMenu === true;
      if (!hasMultipleMenu && menuType !== 'main') {
        return res.status(403).json({
          error:
            'Tu plan actual no incluye la gestión de múltiples menús. Por favor, actualiza tu plan.',
        });
      }

      const existingMenu = await prisma.restaurantMenu.findFirst({
        where: { restaurantId, menuType },
      });

      if (!existingMenu) {
        const total = await countMenus(restaurantId);
        assertCanAddMenu(total, config);
      }

      if (existingMenu) {
        await deleteMenuR2IfPdf(existingMenu);
        const pdfMeta = await uploadPdfToR2(
          restaurantId,
          existingMenu.id,
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );
        const menu = await prisma.restaurantMenu.update({
          where: { id: existingMenu.id },
          data: {
            ...pdfMeta,
            type: 'pdf',
            label: existingMenu.label || legacyLabelForMenuType(menuType),
          },
        });
        return res.json(menu);
      }

      const created = await prisma.restaurantMenu.create({
        data: {
          restaurantId,
          type: 'pdf',
          label: legacyLabelForMenuType(menuType),
          menuType,
          sortOrder: legacySortOrderForMenuType(menuType),
          visible: true,
          url: '',
        },
      });

      const pdfMeta = await uploadPdfToR2(
        restaurantId,
        created.id,
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );

      const menu = await prisma.restaurantMenu.update({
        where: { id: created.id },
        data: pdfMeta,
      });
      res.json(menu);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Legacy: DELETE /api/restaurant/:restaurantId/menus/:menuType
 */
router.delete(
  '/:menuType',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { menuType } = req.params;
      if (!LEGACY_MENU_TYPES.includes(menuType)) {
        return next();
      }

      const { restaurantId } = req.activeRestaurant;
      const menu = await prisma.restaurantMenu.findFirst({
        where: { restaurantId, menuType },
      });

      if (!menu) {
        throw new ValidationError('Menú no encontrado');
      }

      await deleteMenuR2IfPdf(menu);
      await prisma.restaurantMenu.delete({ where: { id: menu.id } });
      res.json({ message: 'Menú eliminado correctamente' });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/restaurant/:restaurantId/menus/:menuId
 */
router.patch(
  '/:menuId',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const { menuId } = req.params;
      const menu = await prisma.restaurantMenu.findFirst({
        where: { id: menuId, restaurantId },
      });
      if (!menu) {
        throw new ValidationError('Carta no encontrada');
      }

      const data = {};
      if (req.body?.label != null) {
        data.label = validateMenuLabel(req.body.label);
      }
      if (req.body?.visible != null) {
        data.visible = Boolean(req.body.visible);
      }
      if (req.body?.sortOrder != null) {
        const so = parseInt(req.body.sortOrder, 10);
        if (!Number.isFinite(so)) throw new ValidationError('sortOrder no válido');
        data.sortOrder = so;
      }
      if (menu.type === 'link' && req.body?.externalUrl != null) {
        const externalUrl = normalizeExternalUrl(req.body.externalUrl);
        data.externalUrl = externalUrl;
        data.url = externalUrl;
      }

      const updated = await prisma.restaurantMenu.update({
        where: { id: menuId },
        data,
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/restaurant/:restaurantId/menus/:menuId/file
 */
router.post(
  '/:menuId/file',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  uploadMenuPdf,
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const { menuId } = req.params;
      if (!req.file) {
        throw new ValidationError('No se subió ningún archivo');
      }

      const menu = await prisma.restaurantMenu.findFirst({
        where: { id: menuId, restaurantId },
      });
      if (!menu) {
        throw new ValidationError('Carta no encontrada');
      }
      if (menu.type !== 'pdf') {
        throw new ValidationError('Solo las cartas PDF pueden reemplazar el archivo');
      }

      await deleteMenuR2IfPdf(menu);

      const pdfMeta = await uploadPdfToR2(
        restaurantId,
        menuId,
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );

      const updated = await prisma.restaurantMenu.update({
        where: { id: menuId },
        data: pdfMeta,
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/restaurant/:restaurantId/menus/:menuId
 */
router.delete(
  '/:menuId',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.activeRestaurant;
      const { menuId } = req.params;

      const menu = await prisma.restaurantMenu.findFirst({
        where: { id: menuId, restaurantId },
      });
      if (!menu) {
        throw new ValidationError('Carta no encontrada');
      }

      await deleteMenuR2IfPdf(menu);
      await prisma.restaurantMenu.delete({ where: { id: menu.id } });
      res.json({ message: 'Carta eliminada correctamente' });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
