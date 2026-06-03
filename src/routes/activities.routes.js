'use strict';

const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateRestaurantRoles } = require('../middleware/authentication');
const { requireActivitiesModulePlan } = require('../middleware/requireActivitiesModulePlan');
const { NotFoundError, ValidationError } = require('../utils/errors');
const {
  getActivityForRestaurant,
  slugify,
  ensureUniqueSlug,
  canUseActivitiesModuleForRestaurant,
} = require('../services/activityService');
const { createSessions, listSessionsWithAvailability } = require('../services/activitySessionService');
const {
  createActivityBooking,
  updateActivityBookingStatus,
} = require('../services/activityBookingService');
const { buildUnifiedCalendar } = require('../services/calendarService');
const { getEffectiveTimezone } = require('../utils/timezone');
const planService = require('../services/planService');

const ROLES_CONFIG = ['restaurant_owner', 'restaurant_manager'];
const ROLES_VIEW = ['restaurant_owner', 'restaurant_manager', 'restaurant_host'];

const r2LogosService = require('../services/r2LogosService');

const MAX_ACTIVITY_IMAGE_BYTES = 5 * 1024 * 1024;

const uploadActivityImageMulter = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError('Solo se permiten imágenes JPG, PNG o WebP'), false);
    }
  },
  limits: { fileSize: MAX_ACTIVITY_IMAGE_BYTES },
});

async function deleteActivityImageFromStorage(imageUrl) {
  if (!imageUrl) return;
  const key = r2LogosService.keyFromLogoUrl(imageUrl);
  if (key) {
    await r2LogosService.deleteLogo(key).catch(() => {});
  }
}

async function handleActivityImageUpload(restaurantId, activityId, file, previousImageUrl) {
  const ext = (file.originalname.match(/\.(jpg|jpeg|png|webp)$/i) || ['', 'png'])[1]?.toLowerCase() || 'png';
  const key = `${restaurantId}/activities/${activityId}-${Date.now()}.${ext}`;

  await r2LogosService.uploadLogo(key, file.buffer, file.mimetype);
  await deleteActivityImageFromStorage(previousImageUrl);

  return r2LogosService.getLogosPublicUrl(key);
}

const router = express.Router({ mergeParams: true });

function sanitizeActivityInput(body) {
  const data = {};
  const fields = [
    'name', 'description', 'includes', 'category', 'imageUrl', 'defaultDurationMinutes',
    'defaultCapacity', 'pricePerPerson', 'currency', 'minimumNoticeMinutes',
    'minPartySize', 'maxPartySize', 'capacityMode', 'blockScope',
    'requiresApproval', 'cancellationPolicy', 'featured', 'sortOrder', 'isActive',
  ];
  for (const key of fields) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  if (data.name !== undefined) data.name = String(data.name).trim().slice(0, 255);
  if (data.description !== undefined) {
    data.description = data.description ? String(data.description).trim().slice(0, 5000) : null;
  }
  if (data.includes !== undefined) {
    data.includes = data.includes ? String(data.includes).trim().slice(0, 3000) : null;
  }
  if (data.imageUrl !== undefined) {
    const trimmed = data.imageUrl ? String(data.imageUrl).trim() : '';
    data.imageUrl = trimmed || null;
  }
  if (data.defaultDurationMinutes !== undefined) {
    data.defaultDurationMinutes = Math.max(15, parseInt(data.defaultDurationMinutes, 10) || 60);
  }
  if (data.defaultCapacity !== undefined) {
    data.defaultCapacity = data.defaultCapacity != null ? parseInt(data.defaultCapacity, 10) : null;
  }
  if (data.pricePerPerson !== undefined) {
    data.pricePerPerson = data.pricePerPerson != null ? parseFloat(data.pricePerPerson) : null;
  }
  if (data.minimumNoticeMinutes !== undefined) {
    data.minimumNoticeMinutes = Math.min(10080, Math.max(0, parseInt(data.minimumNoticeMinutes, 10) || 0));
  }
  if (data.minPartySize !== undefined) data.minPartySize = Math.max(1, parseInt(data.minPartySize, 10) || 1);
  if (data.maxPartySize !== undefined) {
    data.maxPartySize = data.maxPartySize != null ? parseInt(data.maxPartySize, 10) : null;
  }
  if (data.featured !== undefined) data.featured = !!data.featured;
  if (data.requiresApproval !== undefined) data.requiresApproval = !!data.requiresApproval;
  if (data.isActive !== undefined) data.isActive = !!data.isActive;
  if (data.sortOrder !== undefined) data.sortOrder = parseInt(data.sortOrder, 10) || 0;
  return data;
}

async function syncActivityZones(activityId, zoneIds) {
  if (!Array.isArray(zoneIds)) return;
  await prisma.activityZone.deleteMany({ where: { activityId } });
  const unique = [...new Set(zoneIds.filter(Boolean))];
  if (unique.length === 0) return;
  await prisma.activityZone.createMany({
    data: unique.map((zoneId) => ({ activityId, zoneId })),
  });
}

// ─── Activities CRUD ─────────────────────────────────────────────────────────

router.get('/', authenticateRestaurantRoles(ROLES_VIEW), async (req, res, next) => {
  try {
    const { restaurantId } = req.params;
    const hasModule = await canUseActivitiesModuleForRestaurant(restaurantId);
    const activities = await prisma.activity.findMany({
      where: { restaurantId, isDeleted: false },
      orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { zones: { include: { zone: { select: { id: true, name: true } } } } },
    });
    res.json({ activities, hasActivitiesModule: hasModule });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId } = req.params;
    const data = sanitizeActivityInput(req.body);
    if (!data.name) throw new ValidationError('El nombre es obligatorio');
    const baseSlug = slugify(data.name);
    data.slug = await ensureUniqueSlug(restaurantId, baseSlug);
    const { zoneIds } = req.body;

    const activity = await prisma.activity.create({ data: { ...data, restaurantId } });
    await syncActivityZones(activity.id, zoneIds);

    const full = await getActivityForRestaurant(activity.id, restaurantId);
    res.status(201).json({ activity: full });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticateRestaurantRoles(ROLES_VIEW), async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const activity = await getActivityForRestaurant(id, restaurantId);
    if (!activity) throw new NotFoundError('Actividad no encontrada');
    res.json({ activity });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const existing = await getActivityForRestaurant(id, restaurantId);
    if (!existing) throw new NotFoundError('Actividad no encontrada');
    const data = sanitizeActivityInput(req.body);
    if (data.name && data.name !== existing.name) {
      data.slug = await ensureUniqueSlug(restaurantId, slugify(data.name), id);
    }
    await prisma.activity.update({ where: { id }, data });
    if (req.body.zoneIds !== undefined) await syncActivityZones(id, req.body.zoneIds);
    const activity = await getActivityForRestaurant(id, restaurantId);
    res.json({ activity });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const existing = await getActivityForRestaurant(id, restaurantId);
    if (!existing) throw new NotFoundError('Actividad no encontrada');
    const activity = await prisma.activity.update({
      where: { id },
      data: { isDeleted: true, isActive: false },
    });
    res.json({ activity, deleted: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/duplicate', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const original = await getActivityForRestaurant(id, restaurantId);
    if (!original) throw new NotFoundError('Actividad no encontrada');
    const { id: _id, createdAt, updatedAt, zones, sessions, bookings, ...fields } = original;
    const slug = await ensureUniqueSlug(restaurantId, slugify(`${original.name}-copia`));
    const duplicate = await prisma.activity.create({
      data: {
        ...fields,
        name: `${original.name} (copia)`,
        slug,
        isActive: false,
        restaurantId,
      },
    });
    if (zones?.length) {
      await syncActivityZones(duplicate.id, zones.map((z) => z.zoneId));
    }
    const activity = await getActivityForRestaurant(duplicate.id, restaurantId);
    res.status(201).json({ activity });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/toggle', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const existing = await getActivityForRestaurant(id, restaurantId);
    if (!existing) throw new NotFoundError('Actividad no encontrada');
    const activity = await prisma.activity.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    res.json({ activity });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/image',
  authenticateRestaurantRoles(ROLES_CONFIG),
  requireActivitiesModulePlan,
  uploadActivityImageMulter.single('image'),
  async (req, res, next) => {
    try {
      const { restaurantId, id } = req.params;
      if (!req.file) throw new ValidationError('No se subió ninguna imagen');

      const existing = await getActivityForRestaurant(id, restaurantId);
      if (!existing) throw new NotFoundError('Actividad no encontrada');

      const imageUrl = await handleActivityImageUpload(
        restaurantId,
        id,
        req.file,
        existing.imageUrl,
      );

      await prisma.activity.update({ where: { id }, data: { imageUrl } });
      const activity = await getActivityForRestaurant(id, restaurantId);
      res.json({ message: 'Imagen subida correctamente', imageUrl, activity });
    } catch (err) {
      next(err);
    }
  },
);

router.delete('/:id/image', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const existing = await getActivityForRestaurant(id, restaurantId);
    if (!existing) throw new NotFoundError('Actividad no encontrada');

    await deleteActivityImageFromStorage(existing.imageUrl);
    await prisma.activity.update({ where: { id }, data: { imageUrl: null } });
    const activity = await getActivityForRestaurant(id, restaurantId);
    res.json({ message: 'Imagen eliminada', activity });
  } catch (err) {
    next(err);
  }
});

// ─── Sessions ────────────────────────────────────────────────────────────────

router.get('/:id/sessions', authenticateRestaurantRoles(ROLES_VIEW), async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const activity = await getActivityForRestaurant(id, restaurantId);
    if (!activity) throw new NotFoundError('Actividad no encontrada');
    const { from, to } = req.query;
    const sessions = await listSessionsWithAvailability(id, { from, to });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sessions', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const activity = await getActivityForRestaurant(id, restaurantId);
    if (!activity) throw new NotFoundError('Actividad no encontrada');
    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    const timezone = getEffectiveTimezone(restaurant);
    const payload = req.body.single ? { single: req.body.single } : { bulk: req.body.bulk ?? req.body };
    const result = await createSessions(activity, payload, timezone);
    if (result && result.summary) {
      res.status(201).json({ sessions: result.sessions, summary: result.summary });
      return;
    }
    res.status(201).json({
      sessions: [result],
      summary: { requested: 1, created: 1, reactivated: 0, skippedExisting: 0, skippedBlocked: 0 },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sessions/bulk-cancel', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id } = req.params;
    const { sessionIds } = req.body;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new ValidationError('Indica al menos una sesión');
    }
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    const result = await prisma.activitySession.updateMany({
      where: {
        id: { in: uniqueIds },
        activityId: id,
        restaurantId,
        status: 'SCHEDULED',
      },
      data: { status: 'CANCELLED' },
    });
    res.json({ cancelled: result.count, sessionIds: uniqueIds });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/sessions/:sessionId', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id, sessionId } = req.params;
    const session = await prisma.activitySession.findFirst({
      where: { id: sessionId, activityId: id, restaurantId },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const data = {};
    if (req.body.capacity != null) data.capacity = parseInt(req.body.capacity, 10);
    if (req.body.notes !== undefined) data.notes = req.body.notes;
    if (req.body.pricePerPersonOverride !== undefined) {
      data.pricePerPersonOverride = req.body.pricePerPersonOverride != null
        ? parseFloat(req.body.pricePerPersonOverride)
        : null;
    }
    const updated = await prisma.activitySession.update({ where: { id: sessionId }, data });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/sessions/:sessionId/cancel', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id, sessionId } = req.params;
    const session = await prisma.activitySession.findFirst({
      where: { id: sessionId, activityId: id, restaurantId },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const updated = await prisma.activitySession.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED' },
    });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/sessions/:sessionId', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, id, sessionId } = req.params;
    const session = await prisma.activitySession.findFirst({
      where: { id: sessionId, activityId: id, restaurantId },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const bookingCount = await prisma.activityBooking.count({
      where: { sessionId, status: { not: 'CANCELLED' } },
    });
    if (bookingCount > 0) {
      throw new ValidationError('No se puede eliminar una sesión con reservas activas. Cancélala en su lugar.');
    }
    await prisma.activitySession.delete({ where: { id: sessionId } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─── Bookings / roster ───────────────────────────────────────────────────────

router.get('/:id/sessions/:sessionId/bookings', authenticateRestaurantRoles(ROLES_VIEW), async (req, res, next) => {
  try {
    const { restaurantId, id, sessionId } = req.params;
    const session = await prisma.activitySession.findFirst({
      where: { id: sessionId, activityId: id, restaurantId },
    });
    if (!session) throw new NotFoundError('Sesión no encontrada');
    const bookings = await prisma.activityBooking.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ bookings, session });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sessions/:sessionId/bookings', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { partySize, customerName, customerEmail, customerPhone, notes } = req.body;
    if (!customerName || !partySize) throw new ValidationError('Nombre y tamaño del grupo son obligatorios');
    const booking = await createActivityBooking({
      sessionId,
      partySize: parseInt(partySize, 10),
      customerName,
      customerEmail,
      customerPhone,
      notes,
      source: 'manual',
      confirmedByUserId: req.user?.id ?? null,
    });
    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// Separate router for activity-bookings and calendar at restaurant level
const bookingsRouter = express.Router({ mergeParams: true });

bookingsRouter.get('/activity-bookings', authenticateRestaurantRoles(ROLES_VIEW), async (req, res, next) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;
    const where = { restaurantId };
    if (date) {
      where.session = { businessDate: new Date(String(date)) };
    }
    const bookings = await prisma.activityBooking.findMany({
      where,
      include: {
        session: { select: { startAt: true, endAt: true, capacity: true } },
        activity: { select: { name: true, category: true } },
      },
      orderBy: { sessionStartAt: 'asc' },
    });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
});

bookingsRouter.patch('/activity-bookings/:bookingId', authenticateRestaurantRoles(ROLES_CONFIG), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId, bookingId } = req.params;
    const { status } = req.body;
    if (!status) throw new ValidationError('Indica el nuevo estado');
    const booking = await updateActivityBookingStatus(
      bookingId,
      restaurantId,
      status,
      req.user?.id ?? null
    );
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

bookingsRouter.get('/calendar', authenticateRestaurantRoles(ROLES_VIEW), requireActivitiesModulePlan, async (req, res, next) => {
  try {
    const { restaurantId } = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const range = req.query.range === 'week' ? 'week' : 'day';
    const calendar = await buildUnifiedCalendar(restaurantId, String(date), range);
    res.json(calendar);
  } catch (err) {
    next(err);
  }
});

module.exports.bookingsRouter = bookingsRouter;
