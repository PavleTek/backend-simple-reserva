const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join('uploads', 'menus', req.user.restaurantId);
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
    cb(new ValidationError('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post(
  '/menu',
  authenticateToken,
  authenticateRoles(['owner', 'admin']),
  upload.single('menu'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ValidationError('No file uploaded');
      }

      const menuPdfUrl = `/${req.file.path.replace(/\\/g, '/')}`;

      const restaurant = await prisma.restaurant.update({
        where: { id: req.user.restaurantId },
        data: { menuPdfUrl },
      });

      res.json({
        message: 'Menu uploaded successfully',
        menuPdfUrl: restaurant.menuPdfUrl,
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
