const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');
const r2LogosService = require('../services/r2LogosService');

const router = express.Router({ mergeParams: true });

const MAX_MENU_PDF_BYTES = 50 * 1024 * 1024;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const restaurantId = req.activeRestaurant?.restaurantId ?? req.params?.restaurantId;
    const dir = path.join('uploads', 'menus', restaurantId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `menu-${uniqueSuffix}.pdf`);
  },
});

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

const logoFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ValidationError('Solo se permiten imágenes JPG, PNG o WebP'), false);
  }
};

const uploadLogoMulter = multer({
  storage: multer.memoryStorage(),
  fileFilter: logoFileFilter,
  limits: { fileSize: MAX_LOGO_BYTES },
});

/**
 * Shared handler: upload logo buffer to R2, delete old logo, persist absolute URL to DB.
 * @param {string} restaurantId
 * @param {Express.Multer.File} file
 * @returns {Promise<string>} new absolute logoUrl
 */
async function handleLogoUpload(restaurantId, file) {
  const ext = (file.originalname.match(/\.(jpg|jpeg|png|webp)$/i) || ['', 'png'])[1]?.toLowerCase() || 'png';
  const key = `${restaurantId}/logo-${Date.now()}.${ext}`;

  await r2LogosService.uploadLogo(key, file.buffer, file.mimetype);

  const current = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { logoUrl: true },
  });

  if (current?.logoUrl) {
    const oldKey = r2LogosService.keyFromLogoUrl(current.logoUrl);
    if (oldKey) {
      r2LogosService.deleteLogo(oldKey).catch(() => {});
    }
  }

  const logoUrl = r2LogosService.getLogosPublicUrl(key);
  const restaurant = await prisma.restaurant.update({
    where: { id: restaurantId },
    data: { logoUrl },
  });

  return restaurant.logoUrl;
}

router.post(
  '/menu',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  upload.single('menu'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ValidationError('No se subió ningún archivo');
      }

      const menuPdfUrl = `/${req.file.path.replace(/\\/g, '/')}`;

      const current = await prisma.restaurant.findUnique({
        where: { id: req.activeRestaurant.restaurantId },
        select: { menuPdfUrl: true },
      });
      if (current?.menuPdfUrl) {
        const oldPath = path.join(__dirname, '..', '..', current.menuPdfUrl);
        fs.unlink(oldPath, () => {});
      }

      const restaurant = await prisma.restaurant.update({
        where: { id: req.activeRestaurant.restaurantId },
        data: { menuPdfUrl },
      });

      res.json({
        message: 'Menú subido correctamente',
        menuPdfUrl: restaurant.menuPdfUrl,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/logo',
  authenticateToken,
  authorizeRestaurant,
  authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']),
  uploadLogoMulter.single('logo'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ValidationError('No se subió ninguna imagen');
      }

      const restaurantId = req.activeRestaurant.restaurantId;
      const logoUrl = await handleLogoUpload(restaurantId, req.file);

      res.json({ message: 'Logo subido correctamente', logoUrl });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
module.exports.handleLogoUpload = handleLogoUpload;
module.exports.uploadLogoMulter = uploadLogoMulter;
