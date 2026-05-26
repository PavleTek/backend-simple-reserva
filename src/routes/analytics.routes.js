const express = require('express');
const rateLimit = require('express-rate-limit');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');

const router = express.Router();

const analyticsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const marketingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_MARKETING_EVENTS_PER_REQUEST = 50;

const VALID_EVENT_NAMES = new Set([
  'booking.page_view',
  'booking.date_selected',
  'booking.party_selected',
  'booking.slots_loaded',
  'booking.time_selected',
  'booking.zone_selected',
  'booking.contact_view',
  'booking.contact_submitted',
  'booking.confirmed',
  'booking.confirmation_viewed',
  'booking.date_changed',
  'booking.party_changed',
  'booking.zone_changed',
  'booking.zone_no_fit',
  'booking.no_slots_shown',
  'booking.contact_back',
  'booking.submit_error',
  'booking.phone_validation_error',
  'booking.unavailable_date_attempted',
  'booking.slots_empty_for_date',
  'booking.high_demand_slot_selected',
  'booking.page_exit',
  'booking.restaurant_details_toggled',
  'booking.booking_disabled',
  'booking.error_shown',
]);

const VALID_MARKETING_EVENT_NAMES = new Set([
  'marketing.page_view',
  'marketing.scroll_depth',
  'marketing.cta_click',
  'marketing.nav_click',
  'marketing.outbound_click',
]);

/**
 * POST /api/analytics/events
 * Batch ingestion of booking analytics events.
 * Public, rate-limited (10 req/min per IP).
 */
router.post('/events', analyticsRateLimiter, async (req, res, next) => {
  try {
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de eventos' });
    }

    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return res.status(400).json({ error: `Máximo ${MAX_EVENTS_PER_REQUEST} eventos por solicitud` });
    }

    const validEvents = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];

      if (!e || typeof e !== 'object') continue;

      const sessionId = e.sessionId && String(e.sessionId).trim();
      const restaurantId = e.restaurantId && String(e.restaurantId).trim();
      const eventName = e.eventName && String(e.eventName);

      if (!sessionId || !restaurantId || !eventName) continue;
      if (!VALID_EVENT_NAMES.has(eventName)) continue;

      validEvents.push({
        sessionId,
        restaurantId,
        eventName,
        stepName: e.stepName ? String(e.stepName) : null,
        deviceType: e.deviceType ? String(e.deviceType).substring(0, 20) : null,
        userAgent: null,
        properties: sanitizeProperties(e),
      });
    }

    if (validEvents.length === 0) {
      return res.status(200).json({ accepted: 0 });
    }

    const restaurantIds = [...new Set(validEvents.map((ev) => ev.restaurantId))];
    const existingRestaurants = await prisma.restaurant.findMany({
      where: { id: { in: restaurantIds } },
      select: { id: true },
    });
    const existingIds = new Set(existingRestaurants.map((r) => r.id));

    const toInsert = validEvents.filter((ev) => existingIds.has(ev.restaurantId));

    if (toInsert.length > 0) {
      await prisma.bookingEvent.createMany({
        data: toInsert.map((ev) => ({
          sessionId: ev.sessionId,
          restaurantId: ev.restaurantId,
          eventName: ev.eventName,
          stepName: ev.stepName,
          deviceType: ev.deviceType,
          properties: ev.properties ?? Prisma.JsonNull,
        })),
        skipDuplicates: false,
      });
    }

    res.status(200).json({ accepted: toInsert.length });
  } catch (error) {
    next(error);
  }
});

function sanitizeProperties(e) {
  const allowed = [
    'slug',
    'referrer',
    'date',
    'method',
    'dayOfWeek',
    'partySize',
    'usedCustomInput',
    'slotsCount',
    'availableCount',
    'loadTimeMs',
    'time',
    'availableTables',
    'wasScarcity',
    'zoneId',
    'zoneName',
    'selection',
    'elapsedFromPageViewMs',
    'hasEmail',
    'hasNotes',
    'reservationId',
    'totalElapsedMs',
    'fromDate',
    'toDate',
    'hadSlotsLoaded',
    'fromSize',
    'toSize',
    'fromZoneId',
    'toZoneId',
    'reason',
    'elapsedInContactMs',
    'errorMessage',
    'httpStatus',
    'lastStep',
    'totalTimeMs',
    'completed',
    'expanded',
    'step',
    'viewport',
    'timestamp',
  ];

  const props = {};
  for (const key of allowed) {
    if (e[key] !== undefined && e[key] !== null) {
      const val = e[key];
      if (typeof val === 'string' && val.length <= 500) props[key] = val;
      else if (typeof val === 'number' && Number.isFinite(val)) props[key] = val;
      else if (typeof val === 'boolean') props[key] = val;
      else if (typeof val === 'object' && !Array.isArray(val) && key === 'viewport') {
        if (typeof val.width === 'number' && typeof val.height === 'number') {
          props[key] = { width: val.width, height: val.height };
        }
      }
    }
  }
  return Object.keys(props).length > 0 ? props : null;
}

function sanitizeMarketingProperties(e) {
  const props = {};
  const allowed = [
    'label',
    'href',
    'variant',
    'percent',
    'target',
    'channel',
    'referrer',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'isRegister',
  ];
  for (const key of allowed) {
    if (e[key] === undefined || e[key] === null) continue;
    const val = e[key];
    if (typeof val === 'boolean') props[key] = val;
    else if (typeof val === 'number' && Number.isFinite(val)) props[key] = val;
    else if (typeof val === 'string' && val.length <= 500) props[key] = val;
  }
  if (e.properties && typeof e.properties === 'object' && !Array.isArray(e.properties)) {
    for (const key of allowed) {
      if (e.properties[key] !== undefined && e.properties[key] !== null && props[key] === undefined) {
        const val = e.properties[key];
        if (typeof val === 'boolean') props[key] = val;
        else if (typeof val === 'number' && Number.isFinite(val)) props[key] = val;
        else if (typeof val === 'string' && val.length <= 500) props[key] = val;
      }
    }
  }
  return Object.keys(props).length > 0 ? props : null;
}

function normalizePagePath(path) {
  if (!path || typeof path !== 'string') return '/';
  const trimmed = path.trim().slice(0, 200);
  if (!trimmed.startsWith('/')) return `/${trimmed}`;
  return trimmed.split('?')[0] || '/';
}

/**
 * POST /api/analytics/marketing-events
 * Batch ingestion of marketing/landing analytics. Returns 202 quickly.
 */
router.post('/marketing-events', marketingRateLimiter, async (req, res, next) => {
  try {
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de eventos' });
    }

    if (events.length > MAX_MARKETING_EVENTS_PER_REQUEST) {
      return res.status(400).json({ error: `Máximo ${MAX_MARKETING_EVENTS_PER_REQUEST} eventos por solicitud` });
    }

    const validEvents = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e || typeof e !== 'object') continue;

      const sessionId = e.sessionId && String(e.sessionId).trim();
      const eventName = e.eventName && String(e.eventName);
      const pagePath = normalizePagePath(e.pagePath);

      if (!sessionId || !eventName) continue;
      if (!VALID_MARKETING_EVENT_NAMES.has(eventName)) continue;

      const ctaId = e.ctaId ? String(e.ctaId).trim().slice(0, 120) : null;

      validEvents.push({
        sessionId,
        pagePath,
        eventName,
        ctaId,
        deviceType: e.deviceType ? String(e.deviceType).substring(0, 20) : null,
        userAgent: null,
        properties: sanitizeMarketingProperties(e),
      });
    }

    if (validEvents.length === 0) {
      return res.status(202).json({ accepted: 0 });
    }

    await prisma.marketingEvent.createMany({
      data: validEvents.map((ev) => ({
        sessionId: ev.sessionId,
        pagePath: ev.pagePath,
        eventName: ev.eventName,
        ctaId: ev.ctaId,
        deviceType: ev.deviceType,
        properties: ev.properties ?? Prisma.JsonNull,
      })),
      skipDuplicates: false,
    });

    res.status(202).json({ accepted: validEvents.length });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
