const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');
const r2Service = require('../services/r2Service');
const planService = require('../services/planService');
const QRCode = require('qrcode');
const { PDFDocument, rgb } = require('pdf-lib');

const router = express.Router({ mergeParams: true });

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const VALID_MENU_TYPES = ['main', 'drinks', 'dessert'];

/**
 * GET /api/restaurant/:restaurantId/menus
 * List all menus for the restaurant
 */
router.get(
  '/',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
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
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  upload.single('menu'),
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

      const timestamp = Date.now();
      const r2Key = `menus/${restaurantId}/${menuType}-${timestamp}.pdf`;
      
      // Upload to R2
      await r2Service.uploadFile(r2Key, req.file.buffer, req.file.mimetype);

      const publicUrl = r2Service.getPublicUrl(r2Key) || `/api/public/restaurants/id/${restaurantId}/menu/${menuType}`;

      // Upsert DB record
      const menu = await prisma.restaurantMenu.upsert({
        where: {
          restaurantId_menuType: { restaurantId, menuType },
        },
        update: {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          r2Key,
          url: publicUrl,
        },
        create: {
          restaurantId,
          menuType,
          fileName: req.file.originalname,
          fileSize: req.file.size,
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
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
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

/**
 * GET /api/restaurant/:restaurantId/menus/:menuType/qr
 * Generate and return QR code (PNG or PDF)
 */
router.get(
  '/:menuType/qr',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  async (req, res, next) => {
    try {
      const { menuType } = req.params;
      const { restaurantId } = req.activeRestaurant;
      const format = req.query.format || 'png';

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { slug: true, name: true },
      });

      if (!restaurant) {
        throw new ValidationError('Restaurante no encontrado');
      }

      const appUrl = process.env.APP_URL || 'http://localhost:5174';
      const publicUrl = `${appUrl}/r/${restaurant.slug}/menu/${menuType}`;

      if (format === 'pdf') {
        const qrBuffer = await QRCode.toBuffer(publicUrl, { width: 800, margin: 2 });
        
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([400, 500]);
        const qrImage = await pdfDoc.embedPng(qrBuffer);
        
        const qrSize = 300;
        page.drawImage(qrImage, {
          x: 50,
          y: 150,
          width: qrSize,
          height: qrSize,
        });

        page.drawText(restaurant.name, {
          x: 50,
          y: 100,
          size: 20,
          color: rgb(0, 0, 0),
        });

        page.drawText(`Menú: ${menuType}`, {
          x: 50,
          y: 70,
          size: 14,
          color: rgb(0.4, 0.4, 0.4),
        });

        const pdfBytes = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="qr-menu-${menuType}-${restaurant.slug}.pdf"`);
        res.send(Buffer.from(pdfBytes));
      } else {
        const qrBuffer = await QRCode.toBuffer(publicUrl, { width: 400, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="qr-menu-${menuType}-${restaurant.slug}.png"`);
        res.send(qrBuffer);
      }
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
