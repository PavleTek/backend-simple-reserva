'use strict';

const prisma = require('../lib/prisma');
const { normalizeEmail } = require('./reservationNotifyRecipients');

const OWNER_KEY = 'owner';
const BILLING_KEY = 'billing';
const USER_KEY_PREFIX = 'user:';

function userKey(userId) {
  return `${USER_KEY_PREFIX}${userId}`;
}

function parseUserKey(key) {
  if (!key || !key.startsWith(USER_KEY_PREFIX)) return null;
  return key.slice(USER_KEY_PREFIX.length);
}

function displayName(user) {
  if (!user) return 'Sin nombre';
  const parts = [user.name, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : user.email || 'Sin nombre';
}

function parseDateOnly(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Periodo de la prueba gratuita: desde alta de la org hasta fin de trial (o hoy).
 */
function resolveTrialPeriod(createdAt, trialEndsAt) {
  const now = new Date();
  let from = createdAt ? new Date(createdAt) : new Date(now.getFullYear(), now.getMonth(), 1);
  from = new Date(from.getFullYear(), from.getMonth(), from.getDate());

  let to = trialEndsAt ? endOfDay(new Date(trialEndsAt)) : endOfDay(now);
  if (to > endOfDay(now)) to = endOfDay(now);
  if (from > to) from = new Date(to.getFullYear(), to.getMonth(), to.getDate());

  return { from, to };
}

function resolvePeriod(dateFrom, dateTo, orgMeta = null) {
  const fromParsed = parseDateOnly(dateFrom);
  const toParsed = parseDateOnly(dateTo);
  if (fromParsed && toParsed && fromParsed <= toParsed) {
    return { from: fromParsed, to: endOfDay(toParsed) };
  }
  if (orgMeta && (orgMeta.createdAt || orgMeta.trialEndsAt)) {
    return resolveTrialPeriod(orgMeta.createdAt, orgMeta.trialEndsAt);
  }
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: endOfDay(now),
  };
}

function formatTrialEndPhrase(trialEndsAt) {
  if (!trialEndsAt) return 'pronto';
  const end = new Date(trialEndsAt);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const diffDays = Math.round((startEnd - startToday) / MS_DAY);
  if (diffDays === 0) return 'hoy';
  if (diffDays === 1) return 'mañana';
  if (diffDays === -1) return 'ayer';
  return `el ${end.toLocaleDateString('es-CL', { day: 'numeric', month: 'long' })}`;
}

function formatTrialPeriodLabel(from, to) {
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  return `tu prueba gratuita (${from.toLocaleDateString('es-CL', opts)} – ${to.toLocaleDateString('es-CL', opts)})`;
}

function formatPeriodLabel(from, to) {
  const opts = { day: 'numeric', month: 'long', year: 'numeric' };
  const fromStr = from.toLocaleDateString('es-CL', opts);
  const toStr = to.toLocaleDateString('es-CL', opts);
  if (from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear() && from.getDate() === 1) {
    return to.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  }
  return `${fromStr} – ${toStr}`;
}

const STATUS_LABELS = {
  confirmed: 'Confirmadas',
  completed: 'Completadas',
  cancelled: 'Canceladas',
  no_show: 'No se presentaron',
};

const SOURCE_LABELS = {
  web: 'Reserva online',
  manual: 'Panel del local',
  phone: 'Teléfono / otro',
  staff: 'Equipo',
  api: 'Integración',
};

const MS_DAY = 24 * 60 * 60 * 1000;
/** Minutos evitados por reserva web vs coordinación manual (teléfono/WhatsApp). */
const MINUTES_SAVED_PER_WEB_BOOKING = 6;

function formatClNumber(n) {
  return new Intl.NumberFormat('es-CL').format(Math.round(Number(n) || 0));
}

function inclusivePeriodDays(from, to) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(1, Math.round((end - start) / MS_DAY) + 1);
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}

/**
 * Highlights operativos + proyecciones a partir del ritmo del periodo.
 */
function buildHighlightsAndProjection({
  total,
  covers,
  statusCounts,
  webCount,
  webSharePercent,
  from,
  to,
  trialEndsAt = null,
}) {
  const highlights = [];
  const projection = { lines: [], callout: null };

  if (total <= 0) {
    return { highlights, projection };
  }

  const confirmed = statusCounts.confirmed ?? 0;
  const completed = statusCounts.completed ?? 0;
  const coordinated = confirmed + completed;

  highlights.push(
    trialEndsAt
      ? `${formatClNumber(total)} ${plural(total, 'reserva gestionada', 'reservas gestionadas')} durante tu prueba`
      : `${formatClNumber(total)} ${plural(total, 'reserva gestionada', 'reservas gestionadas')} en el periodo`,
  );

  if (covers > 0) {
    highlights.push(`${formatClNumber(covers)} comensales en total`);
  }

  if (confirmed > 0) {
    highlights.push(
      `${formatClNumber(confirmed)} ${plural(confirmed, 'reserva confirmada', 'reservas confirmadas')} (en agenda o por atender)`,
    );
  }

  if (completed > 0) {
    highlights.push(
      `${formatClNumber(completed)} ${plural(completed, 'visita marcada como completada', 'visitas marcadas como completadas')}`,
    );
  }

  if (coordinated > 0 && (confirmed > 0 && completed > 0)) {
    highlights.push(
      `${formatClNumber(coordinated)} mesas ya coordinadas en SimpleReserva (confirmadas + completadas)`,
    );
  }

  if (webSharePercent != null && webSharePercent >= 20) {
    highlights.push(
      `${webSharePercent}% de las reservas llegaron por tu enlace online`,
    );
  }

  const periodDays = inclusivePeriodDays(from, to);
  const dailyReservations = total / periodDays;
  const dailyCovers = covers / periodDays;
  const isTrialEnd = Boolean(trialEndsAt);

  if (isTrialEnd && periodDays >= 2) {
    const projectedMonthReservations = Math.round(dailyReservations * 30);
    const projectedMonthCovers = Math.round(dailyCovers * 30);
    projection.lines.push(
      `Si activas tu plan y mantienes este ritmo, el próximo mes podrías gestionar ~${formatClNumber(projectedMonthReservations)} reservas y ~${formatClNumber(projectedMonthCovers)} comensales sin volver al caos de WhatsApp y cuadernos.`,
    );
  } else {
    const sameCalendarMonth =
      from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
    const daysInMonth = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
    const throughDay = to.getDate();
    const partialMonth = sameCalendarMonth && throughDay < daysInMonth && periodDays >= 3;

    if (partialMonth) {
      const projectedReservations = Math.round(dailyReservations * daysInMonth);
      const projectedCovers = Math.round(dailyCovers * daysInMonth);
      const monthName = to.toLocaleDateString('es-CL', { month: 'long' });
      projection.lines.push(
        `Si mantienes este ritmo, cerrarías ${monthName} con ~${formatClNumber(projectedReservations)} reservas y ~${formatClNumber(projectedCovers)} comensales.`,
      );
    } else if (periodDays >= 7) {
      const projectedMonthReservations = Math.round(dailyReservations * 30);
      const projectedMonthCovers = Math.round(dailyCovers * 30);
      projection.lines.push(
        `A este ritmo, en un mes típico serían ~${formatClNumber(projectedMonthReservations)} reservas y ~${formatClNumber(projectedMonthCovers)} comensales.`,
      );
    }
  }

  if (webCount >= 2) {
    const minutesSaved = webCount * MINUTES_SAVED_PER_WEB_BOOKING;
    const hoursSaved = Math.max(1, Math.round(minutesSaved / 60));
    projection.lines.push(
      `En la prueba, ${formatClNumber(webCount)} reservas online ya te ahorraron ~${hoursSaved} ${plural(hoursSaved, 'hora', 'horas')} de coordinación por teléfono o WhatsApp.`,
    );
  }

  if (isTrialEnd) {
    const endsPhrase = formatTrialEndPhrase(trialEndsAt);
    if (total >= 8) {
      projection.callout = `Tu prueba gratuita termina ${endsPhrase}. Sin activar un plan pierdes el enlace de reservas, el panel y el historial que tu equipo ya usa cada día.`;
    } else if (total >= 1) {
      projection.callout = `Tu prueba gratuita termina ${endsPhrase}. Activa tu plan para no cortar el flujo: cada reserva que sumes ahora es base para crecer con datos reales, no suposiciones.`;
    } else {
      projection.callout = `Tu prueba gratuita termina ${endsPhrase}. Activa tu plan para seguir con enlace de reservas y panel listos cuando llegue tu próxima ola de mesas.`;
    }
  } else if (coordinated >= 10 || total >= 15) {
    projection.callout =
      'Tu operación ya corre con reservas centralizadas: dejar de usar el panel y el enlace web significa volver a perder mesas y duplicar llamadas.';
  } else if (total >= 5) {
    projection.callout =
      'Vas ganando tracción: cada reserva en el sistema es una mesa asegurada y un dato que mañana puedes reutilizar.';
  }

  return { highlights, projection };
}

/**
 * @returns {Promise<Array<{ key: string, kind: string, name: string, email: string|null, roleLabel: string, canSelect: boolean }>>}
 */
async function loadOrganizationEmailRecipients(organizationId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    include: {
      owner: { select: { id: true, email: true, name: true, lastName: true } },
      managers: { include: { user: { select: { id: true, email: true, name: true, lastName: true } } } },
      hosts: { include: { user: { select: { id: true, email: true, name: true, lastName: true } } } },
    },
  });

  if (!org) return [];

  const rows = [];
  const seenEmails = new Set();

  if (org.owner) {
    const email = normalizeEmail(org.owner.email);
    rows.push({
      key: OWNER_KEY,
      kind: 'owner',
      name: displayName(org.owner),
      email,
      roleLabel: 'Propietario',
      canSelect: Boolean(email),
    });
    if (email) seenEmails.add(email);
  }

  const addMember = (user, roleLabel, kind) => {
    if (!user) return;
    const email = normalizeEmail(user.email);
    if (email && seenEmails.has(email)) return;
    if (email) seenEmails.add(email);
    rows.push({
      key: userKey(user.id),
      kind,
      name: displayName(user),
      email,
      roleLabel,
      canSelect: Boolean(email),
    });
  };

  for (const m of org.managers) addMember(m.user, 'Gerente', 'manager');
  for (const h of org.hosts) addMember(h.user, 'Anfitrión', 'host');

  const billingEmail = normalizeEmail(org.billingEmail);
  if (billingEmail && !seenEmails.has(billingEmail)) {
    rows.push({
      key: BILLING_KEY,
      kind: 'billing',
      name: org.billingBusinessName || 'Facturación',
      email: billingEmail,
      roleLabel: 'Correo de facturación',
      canSelect: true,
    });
  }

  return rows;
}

function resolveRecipientsByKeys(catalog, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const keySet = new Set(keys.map(String));
  const resolved = [];
  const seen = new Set();

  for (const row of catalog) {
    if (!keySet.has(row.key) || !row.email || !row.canSelect) continue;
    const email = normalizeEmail(row.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    resolved.push({
      email,
      name: row.name,
      roleLabel: row.roleLabel,
    });
  }

  return resolved;
}

/**
 * @returns {Promise<object>}
 */
async function computeOrganizationPeriodSummary(organizationId, { dateFrom, dateTo } = {}) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      trialEndsAt: true,
      restaurants: {
        where: { isDeleted: false },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      },
    },
  });

  if (!org) return null;

  const { from, to } = resolvePeriod(dateFrom, dateTo, {
    createdAt: org.createdAt,
    trialEndsAt: org.trialEndsAt,
  });
  const trialEndsAt = org.trialEndsAt;
  const periodLabel = trialEndsAt
    ? formatTrialPeriodLabel(from, to)
    : formatPeriodLabel(from, to);
  const trialMeta = trialEndsAt
    ? {
        endsAt: new Date(trialEndsAt).toISOString(),
        endsAtDisplay: new Date(trialEndsAt).toLocaleDateString('es-CL', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
        endsPhrase: formatTrialEndPhrase(trialEndsAt),
        trialDays: inclusivePeriodDays(from, to),
      }
    : null;

  const restaurantIds = org.restaurants.map((r) => r.id);

  if (restaurantIds.length === 0) {
    return {
      organizationId: org.id,
      organizationName: org.name,
      trial: trialMeta,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        label: periodLabel,
      },
      totals: {
        reservations: 0,
        covers: 0,
        avgPartySize: null,
        webCount: 0,
        webSharePercent: null,
      },
      byStatus: {},
      bySource: {},
      byRestaurant: [],
      highlights: [],
      projection: { lines: [], callout: null },
    };
  }

  const reservationWhere = {
    restaurantId: { in: restaurantIds },
    dateTime: { gte: from, lte: to },
  };

  const [agg, byStatus, bySource, byRestaurant] = await Promise.all([
    prisma.reservation.aggregate({
      where: reservationWhere,
      _count: { _all: true },
      _sum: { partySize: true },
      _avg: { partySize: true },
    }),
    prisma.reservation.groupBy({
      by: ['status'],
      where: reservationWhere,
      _count: { _all: true },
    }),
    prisma.reservation.groupBy({
      by: ['source'],
      where: reservationWhere,
      _count: { _all: true },
    }),
    prisma.reservation.groupBy({
      by: ['restaurantId'],
      where: reservationWhere,
      _count: { _all: true },
      _sum: { partySize: true },
      orderBy: { _count: { restaurantId: 'desc' } },
    }),
  ]);

  const total = agg._count._all;
  const covers = agg._sum.partySize ?? 0;
  const avgPartySize =
    total > 0 && agg._avg.partySize != null ? Math.round(agg._avg.partySize * 10) / 10 : null;

  const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
  const sourceCounts = Object.fromEntries(bySource.map((r) => [r.source, r._count._all]));

  const webCount = sourceCounts.web ?? 0;
  const webSharePercent = total > 0 ? Math.round((webCount / total) * 1000) / 10 : null;

  const nameById = Object.fromEntries(org.restaurants.map((r) => [r.id, r.name]));
  const restaurantRows = byRestaurant.map((g) => ({
    restaurantId: g.restaurantId,
    name: nameById[g.restaurantId] ?? g.restaurantId,
    reservations: g._count._all,
    covers: g._sum.partySize ?? 0,
    sharePercent: total > 0 ? Math.round((g._count._all / total) * 1000) / 10 : 0,
  }));

  const { highlights, projection } = buildHighlightsAndProjection({
    total,
    covers,
    statusCounts,
    webCount,
    webSharePercent,
    from,
    to,
    trialEndsAt,
  });

  return {
    organizationId: org.id,
    organizationName: org.name,
    trial: trialMeta,
    period: {
      from: from.toISOString(),
      to: to.toISOString(),
      label: periodLabel,
    },
    totals: {
      reservations: total,
      covers,
      avgPartySize,
      webCount,
      webSharePercent,
    },
    byStatus: Object.fromEntries(
      Object.entries(statusCounts).map(([k, v]) => [k, { count: v, label: STATUS_LABELS[k] ?? k }]),
    ),
    bySource: Object.fromEntries(
      Object.entries(sourceCounts).map(([k, v]) => [k, { count: v, label: SOURCE_LABELS[k] ?? k }]),
    ),
    byRestaurant: restaurantRows,
    highlights,
    projection,
  };
}

/**
 * Arma subject + HTML del correo de fin de prueba (misma plantilla que el envío).
 */
function buildPeriodSummaryEmailPayload({
  summary,
  recipientName,
  organizationId,
  personalNote = '',
}) {
  const { billingUrl } = require('../utils/restaurantPanelUrl');
  const {
    buildOrganizationPeriodSummaryHtml,
    buildOrganizationPeriodSummarySubject,
    buildOrganizationPeriodSummaryPreheader,
  } = require('../templates/organizationPeriodSummaryEmail');

  const panelUrl = `${billingUrl()}?organizationId=${organizationId}`;
  const assetBaseUrl =
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    '';

  const html = buildOrganizationPeriodSummaryHtml({
    summary,
    recipientName,
    panelUrl,
    assetBaseUrl: String(assetBaseUrl).replace(/\/$/, ''),
    personalNote,
  });

  return {
    subject: buildOrganizationPeriodSummarySubject(summary),
    preheader: buildOrganizationPeriodSummaryPreheader(summary),
    html,
    panelUrl,
  };
}

module.exports = {
  OWNER_KEY,
  BILLING_KEY,
  userKey,
  loadOrganizationEmailRecipients,
  resolveRecipientsByKeys,
  computeOrganizationPeriodSummary,
  buildPeriodSummaryEmailPayload,
  buildHighlightsAndProjection,
  resolvePeriod,
  resolveTrialPeriod,
  formatPeriodLabel,
  formatTrialEndPhrase,
};
