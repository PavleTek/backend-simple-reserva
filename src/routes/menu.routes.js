const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_CONFIG } = require('../auth/roles');
const { ValidationError } = require('../utils/errors');
const r2Service = require('../services/r2Service');
const planService = require('../services/planService');
const { compressPdfBuffer } = require('../services/pdfCompressionService');

const router = express.Router({ mergeParams: true });

const MAX_MENU_PDF_BYTES = 50 * 1024 * 1024;
const MAX_MENU_PDF_MB = 50;

// Use memory storage for R2 uploads
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

/** Wraps multer so LIMIT_FILE_SIZE returns a clear ValidationError (es-CL). */
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

const VALID_MENU_TYPES = ['main', 'drinks', 'dessert'];

/**
 * GET /api/restaurant/:restaurantId/menus
 * List all menus for the restaurant
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
        orderBy: { menuType: 'asc' },
      });
      res.json(menus);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/restaurant/:restaurantId/menus/:menuType
 * Upload/replace a menu PDF
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
      const { restaurantId } = req.activeRestaurant;

      if (!VALID_MENU_TYPES.includes(menuType)) {
        throw new ValidationError('Tipo de menú no válido');
      }

      if (!req.file) {
        throw new ValidationError('No se subió ningún archivo');
      }

      // Check plan feature (use restaurant's organization plan so managers get correct check)
      const config = await planService.resolvePlanConfigForRestaurant(restaurantId);
      const hasMultipleMenu = config && config.multipleMenu === true;
      if (!hasMultipleMenu && menuType !== 'main') {
        return res.status(403).json({
          error: 'Tu plan actual no incluye la gestión de múltiples menús. Por favor, actualiza tu plan.',
        });
      }

      // Find existing menu to delete from R2 if replacing
      const existingMenu = await prisma.restaurantMenu.findUnique({
        where: {
          restaurantId_menuType: { restaurantId, menuType },
        },
      });

      if (existingMenu) {
        await r2Service.deleteFile(existingMenu.r2Key).catch(err => {
          console.error('Error deleting old menu from R2:', err);
        });
      }

      const { buffer: uploadBuffer } = await compressPdfBuffer(req.file.buffer);

      if (uploadBuffer.length > MAX_MENU_PDF_BYTES) {
        throw new ValidationError(
          `El PDF sigue siendo demasiado grande después de optimizarlo (máx. ${MAX_MENU_PDF_MB} MB). ` +
            'Prueba comprimirlo con otra herramienta o reducir las imágenes del documento.'
        );
      }

      const timestamp = Date.now();
      const r2Key = `menus/${restaurantId}/${menuType}-${timestamp}.pdf`;

      await r2Service.uploadFile(r2Key, uploadBuffer, req.file.mimetype);

      const publicUrl = r2Service.getPublicUrl(r2Key) || `/api/public/restaurants/id/${restaurantId}/menu/${menuType}`;

      const menu = await prisma.restaurantMenu.upsert({
        where: {
          restaurantId_menuType: { restaurantId, menuType },
        },
        update: {
          fileName: req.file.originalname,
          fileSize: uploadBuffer.length,
          r2Key,
          url: publicUrl,
        },
        create: {
          restaurantId,
          menuType,
          fileName: req.file.originalname,
          fileSize: uploadBuffer.length,
          r2Key,
          url: publicUrl,
        },
      });

      res.json(menu);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/restaurant/:restaurantId/menus/:menuType
 * Delete a menu
 */
router.delete(
  '/:menuType',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(ROLES_CONFIG),
  async (req, res, next) => {
    try {
      const { menuType } = req.params;
      const { restaurantId } = req.activeRestaurant;

      const menu = await prisma.restaurantMenu.findUnique({
        where: {
          restaurantId_menuType: { restaurantId, menuType },
        },
      });

      if (!menu) {
        throw new ValidationError('Menú no encontrado');
      }

      // Delete from R2
      await r2Service.deleteFile(menu.r2Key).catch(err => {
        console.error('Error deleting menu from R2:', err);
      });

      // Delete from DB
      await prisma.restaurantMenu.delete({
        where: { id: menu.id },
      });

      res.json({ message: 'Menú eliminado correctamente' });
    } catch (error) {
      next(error);
    }
  }
);




module.exports = router;
