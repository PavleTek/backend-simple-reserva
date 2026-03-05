const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');

const router = express.Router({ mergeParams: true });

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
  limits: { fileSize: 10 * 1024 * 1024 },
});

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const restaurantId = req.activeRestaurant?.restaurantId ?? req.params?.restaurantId;
    const dir = path.join('uploads', 'logos', restaurantId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (file.originalname.match(/\.(jpg|jpeg|png|webp)$/i) || ['', 'png'])[1]?.toLowerCase() || 'png';
    cb(null, `logo-${Date.now()}.${ext}`);
  },
});

const logoFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ValidationError('Solo se permiten imágenes JPG, PNG o WebP'), false);
  }
};

const uploadLogo = multer({
  storage: logoStorage,
  fileFilter: logoFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

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
  uploadLogo.single('logo'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ValidationError('No se subió ninguna imagen');
      }

      const logoUrl = `/${req.file.path.replace(/\\/g, '/')}`;

      const current = await prisma.restaurant.findUnique({
        where: { id: req.activeRestaurant.restaurantId },
        select: { logoUrl: true },
      });
      if (current?.logoUrl) {
        const oldPath = path.join(__dirname, '..', '..', current.logoUrl);
        fs.unlink(oldPath, () => {});
      }

      const restaurant = await prisma.restaurant.update({
        where: { id: req.activeRestaurant.restaurantId },
        data: { logoUrl },
      });

      res.json({
        message: 'Logo subido correctamente',
        logoUrl: restaurant.logoUrl,
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
