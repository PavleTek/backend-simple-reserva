const express = require('express');
const prisma = require('../lib/prisma');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = express.Router();

// ─── Token-based reservation routes ─────────────────────────────
// Defined before /:slug params to avoid route collisions when
// this router is mounted at both /api/restaurants and /api/reservations

router.get('/token/:secureToken', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
      include: {
        restaurant: { select: { name: true } },
        table: { select: { label: true } },
      },
    });

    if (!reservation) throw new NotFoundError('Reservation not found');

    res.json(reservation);
  } catch (error) {
    next(error);
  }
});

router.patch('/token/:secureToken/cancel', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { secureToken: req.params.secureToken },
    });

    if (!reservation) throw new NotFoundError('Reservation not found');

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: 'cancelled' },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// ─── Create reservation ─────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const {
      restaurantSlug,
      date,
      time,
      partySize,
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = req.body;

    if (!restaurantSlug || !date || !time || !partySize || !customerName || !customerPhone) {
      throw new ValidationError(
        'restaurantSlug, date, time, partySize, customerName, and customerPhone are required'
      );
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize must be a positive number');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: restaurantSlug, isActive: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const dateTime = new Date(`${date}T${time}:00`);
    if (isNaN(dateTime.getTime())) {
      throw new ValidationError('Invalid date or time format');
    }

    const slotDuration = restaurant.defaultSlotDurationMinutes;
    const slotEnd = new Date(dateTime.getTime() + slotDuration * 60000);
    const dayOfWeek = dateTime.getDay();

    const reservation = await prisma.$transaction(
      async (tx) => {
        const schedule = await tx.schedule.findFirst({
          where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
        });
        if (!schedule) throw new ValidationError('Restaurant is closed on this day');

        const [openH, openM] = schedule.openTime.split(':').map(Number);
        const [closeH, closeM] = schedule.closeTime.split(':').map(Number);
        const reqMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
        const openMin = openH * 60 + openM;
        const closeMin = closeH * 60 + closeM;

        if (reqMinutes < openMin || reqMinutes + slotDuration > closeMin) {
          throw new ValidationError('Requested time is outside operating hours');
        }

        const blocked = await tx.blockedSlot.findFirst({
          where: {
            restaurantId: restaurant.id,
            startDatetime: { lt: slotEnd },
            endDatetime: { gt: dateTime },
          },
        });
        if (blocked) {
          throw new ValidationError(
            'This time slot is blocked' + (blocked.reason ? ': ' + blocked.reason : '')
          );
        }

        const tables = await tx.restaurantTable.findMany({
          where: {
            isActive: true,
            minCapacity: { lte: size },
            maxCapacity: { gte: size },
            zone: { restaurantId: restaurant.id, isActive: true },
          },
          orderBy: { maxCapacity: 'asc' },
        });
        if (tables.length === 0) {
          throw new ValidationError('No tables available for this party size');
        }

        const dayStart = new Date(`${date}T00:00:00`);
        const dayEnd = new Date(`${date}T23:59:59`);

        const dayReservations = await tx.reservation.findMany({
          where: {
            tableId: { in: tables.map((t) => t.id) },
            status: 'confirmed',
            dateTime: { gte: dayStart, lte: dayEnd },
          },
        });

        let selectedTable = null;
        for (const table of tables) {
          const hasConflict = dayReservations.some((r) => {
            if (r.tableId !== table.id) return false;
            const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000);
            return dateTime < rEnd && slotEnd > r.dateTime;
          });
          if (!hasConflict) {
            selectedTable = table;
            break;
          }
        }

        if (!selectedTable) {
          throw new ValidationError('No tables available at this time');
        }

        return tx.reservation.create({
          data: {
            restaurantId: restaurant.id,
            tableId: selectedTable.id,
            customerName,
            customerPhone,
            customerEmail: customerEmail || null,
            partySize: size,
            dateTime,
            durationMinutes: slotDuration,
            notes: notes || null,
          },
          include: {
            restaurant: { select: { name: true } },
            table: { select: { label: true } },
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );

    res.status(201).json(reservation);
  } catch (error) {
    next(error);
  }
});

// ─── Public restaurant routes (slug-based) ──────────────────────

router.get('/:slug/availability', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { date, partySize } = req.query;

    console.log(`Checking availability for ${slug} on ${date} with partySize ${partySize}`);

    if (!date || !partySize) {
      throw new ValidationError('date and partySize query params are required');
    }

    const size = parseInt(partySize);
    if (isNaN(size) || size < 1) {
      throw new ValidationError('partySize must be a positive number');
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug, isActive: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const requestedDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = requestedDate.getDay();

    console.log(`Day of week: ${dayOfWeek}`);

    const schedule = await prisma.schedule.findFirst({
      where: { restaurantId: restaurant.id, dayOfWeek, isActive: true },
    });
    if (!schedule) {
      console.log('No active schedule found for this day');
      return res.json({ slots: [] });
    }

    console.log(`Schedule found: ${schedule.openTime} - ${schedule.closeTime}`);

    const tables = await prisma.restaurantTable.findMany({
      where: {
        isActive: true,
        minCapacity: { lte: size },
        maxCapacity: { gte: size },
        zone: { restaurantId: restaurant.id, isActive: true },
      },
      orderBy: { maxCapacity: 'asc' },
    });
    
    console.log(`Found ${tables.length} suitable tables`);

    if (tables.length === 0) return res.json({ slots: [] });

    const [openH, openM] = schedule.openTime.split(':').map(Number);
    const [closeH, closeM] = schedule.closeTime.split(':').map(Number);
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;
    const duration = restaurant.defaultSlotDurationMinutes;

    const timeSlots = [];
    for (let m = openMin; m + duration <= closeMin; m += duration) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const time = `${hh}:${mm}`;
      const start = new Date(`${date}T${time}:00`);
      const end = new Date(start.getTime() + duration * 60000);
      timeSlots.push({ time, start, end });
    }
    if (timeSlots.length === 0) return res.json({ slots: [] });

    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

    const [blockedSlots, existingReservations] = await Promise.all([
      prisma.blockedSlot.findMany({
        where: {
          restaurantId: restaurant.id,
          startDatetime: { lte: dayEnd },
          endDatetime: { gte: dayStart },
        },
      }),
      prisma.reservation.findMany({
        where: {
          restaurantId: restaurant.id,
          tableId: { in: tables.map((t) => t.id) },
          status: 'confirmed',
          dateTime: { gte: dayStart, lte: dayEnd },
        },
      }),
    ]);

    const available = [];
    for (const slot of timeSlots) {
      const isBlocked = blockedSlots.some(
        (bs) => slot.start < bs.endDatetime && slot.end > bs.startDatetime
      );
      if (isBlocked) continue;

      let openTables = 0;
      for (const table of tables) {
        const booked = existingReservations.some((r) => {
          if (r.tableId !== table.id) return false;
          const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000);
          return slot.start < rEnd && slot.end > r.dateTime;
        });
        if (!booked) openTables++;
      }

      if (openTables > 0) {
        available.push({ 
          time: slot.time, 
          available: true,
          availableTables: openTables 
        });
      }
    }

    res.json({ slots: available });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: req.params.slug },
      select: {
        name: true,
        description: true,
        address: true,
        phone: true,
        email: true,
        menuPdfUrl: true,
        zones: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            tables: {
              where: { isActive: true },
              select: {
                id: true,
                label: true,
                minCapacity: true,
                maxCapacity: true,
              },
            },
          },
        },
      },
    });

    if (!restaurant) throw new NotFoundError('Restaurant not found');

    res.json(restaurant);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
