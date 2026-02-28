const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authenticateRoles } = require('../middleware/authentication');
const { getRestaurant, updateRestaurant } = require('../controllers/restaurantController');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = express.Router();

router.use(authenticateToken);
router.use(authenticateRoles(['owner', 'admin']));

router.get('/', getRestaurant);
router.patch('/', authenticateRoles(['owner']), updateRestaurant);

// --- Reservations sub-routes ---

router.get('/reservations', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { date, status, search } = req.query;

    const where = { restaurantId: req.user.restaurantId };

    if (date) {
      const start = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      where.dateTime = { gte: start, lt: end };
    }

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        include: { table: { select: { id: true, label: true } } },
        orderBy: { dateTime: 'desc' },
        skip,
        take: limit,
      }),
      prisma.reservation.count({ where }),
    ]);

    res.json(paginatedResponse(reservations, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.patch('/reservations/:id', async (req, res, next) => {
  try {
    const { status } = req.body;

    if (!status) {
      throw new ValidationError('Status is required');
    }

    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
    });

    if (!reservation) {
      throw new NotFoundError('Reservation not found');
    }

    if (reservation.restaurantId !== req.user.restaurantId) {
      throw new NotFoundError('Reservation not found');
    }

    const updated = await prisma.reservation.update({
      where: { id: req.params.id },
      data: { status },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// --- Blocked Slots sub-routes ---

router.get('/blocked-slots', async (req, res, next) => {
  try {
    const slots = await prisma.blockedSlot.findMany({
      where: { restaurantId: req.user.restaurantId },
      orderBy: { startDatetime: 'asc' },
    });

    res.json(slots);
  } catch (error) {
    next(error);
  }
});

router.post('/blocked-slots', async (req, res, next) => {
  try {
    const { startDatetime, endDatetime, reason } = req.body;

    if (!startDatetime || !endDatetime) {
      throw new ValidationError('startDatetime and endDatetime are required');
    }

    const slot = await prisma.blockedSlot.create({
      data: {
        restaurantId: req.user.restaurantId,
        startDatetime: new Date(startDatetime),
        endDatetime: new Date(endDatetime),
        reason: reason || null,
      },
    });

    res.status(201).json(slot);
  } catch (error) {
    next(error);
  }
});

router.delete('/blocked-slots/:id', async (req, res, next) => {
  try {
    const slot = await prisma.blockedSlot.findUnique({
      where: { id: req.params.id },
    });

    if (!slot) {
      throw new NotFoundError('Blocked slot not found');
    }

    if (slot.restaurantId !== req.user.restaurantId) {
      throw new NotFoundError('Blocked slot not found');
    }

    await prisma.blockedSlot.delete({ where: { id: req.params.id } });

    res.json({ message: 'Blocked slot deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
