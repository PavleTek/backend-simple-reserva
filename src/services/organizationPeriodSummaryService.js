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

function periodDaysCount(from, to) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(1, Math.round((end - start) / MS_DAY));
}

/** @deprecated use periodDaysCount */
const inclusivePeriodDays = periodDaysCount;

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}

/**
 * Proyección de crecimiento no lineal a 1/3/6/12 meses.
 *
 * Modelo: crecimiento compuesto mensual calibrado por dos señales observables:
 *   1. webSharePercent → adopción del enlace online (descubrimiento orgánico)
 *   2. baseMonthly     → volumen base (bajo = más margen de crecimiento)
 *
 * Las reservas completadas se excluyen como señal porque se marcan manualmente.
 * No es lineal porque los negocios que adoptan reservas online suelen crecer
 * más rápido en los primeros meses por boca a boca + SEO; luego se estabiliza.
 * Los multiplicadores están calculados como compuesto: (1 + r)^n donde r es la
 * tasa mensual estimada según el perfil de la organización.
 */
const GROWTH_TIER_MULTIPLIERS = {
  //              1 mes   3 meses  6 meses  12 meses
  high:          [1.10,   1.33,   1.73,    2.60],
  mid:           [1.07,   1.23,   1.50,    2.05],
  low:           [1.03,   1.12,   1.26,    1.55],
};

function resolveGrowthTier({ webSharePercent, baseMonthly }) {
  let score = 0;
  // Señal 1: adopción online (link compartido activamente → descubrimiento orgánico)
  if ((webSharePercent ?? 0) >= 60) score += 2;
  else if ((webSharePercent ?? 0) >= 25) score += 1;
  // Señal 2: volumen base bajo → más margen de crecimiento
  if (baseMonthly < 20) score += 2;
  else if (baseMonthly < 60) score += 1;

  if (score >= 3) return 'high';
  if (score >= 2) return 'mid';
  return 'low';
}

/**
 * @returns {Array<{ months: number, reservations: number, covers: number, growthLabel: string }>|null}
 */
function buildGrowthProjections({ total, covers, webSharePercent, from, to }) {
  const days = periodDaysCount(from, to);
  if (days < 2 || total < 1) return null;

  const baseMonthly = (total / days) * 30;
  const baseMonthlyCovers = (covers / days) * 30;

  const tier = resolveGrowthTier({ webSharePercent, baseMonthly });
  const mults = GROWTH_TIER_MULTIPLIERS[tier];

  const labels = { high: 'acelerado', mid: 'moderado', low: 'conservador' };
  const growthLabel = labels[tier];

  return [1, 3, 6, 12].map((months, i) => ({
    months,
    reservations: Math.round(baseMonthly * mults[i]),
    covers: Math.round(baseMonthlyCovers * mults[i]),
    growthLabel,
  }));
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
      `A este ritmo, el próximo mes podrías gestionar ~${formatClNumber(projectedMonthReservations)} reservas y ~${formatClNumber(projectedMonthCovers)} comensales — sin agregar carga a tu equipo.`,
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
    highlights.push(
      `${formatClNumber(webCount)} reservas llegaron por el enlace online — ~${hoursSaved} ${plural(hoursSaved, 'hora', 'horas')} que tu equipo dedicó a la sala en vez del teléfono`,
    );
  }

  if (isTrialEnd) {
    if (total >= 8) {
      projection.callout = `Tu historial, enlace y panel están listos para seguir — exactamente donde los dejaste. Solo activa tu plan para que nada se detenga.`;
    } else if (total >= 1) {
      projection.callout = `Tienes la base funcionando. Activa tu plan para seguir construyendo sobre lo que ya avanzaste en la prueba.`;
    } else {
      projection.callout = `Tu enlace y panel quedan listos con un plan activo. Cuando lleguen las reservas, el sistema ya sabe cómo recibirlas.`;
    }
  } else if (coordinated >= 10 || total >= 15) {
    projection.callout =
      'Tu operación ya funciona con reservas centralizadas. Sigue construyendo sobre esa base.';
  } else if (total >= 5) {
    projection.callout =
      'Cada reserva en el sistema es una mesa asegurada y un dato que mañana puedes reutilizar.';
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
        trialDays: periodDaysCount(from, to),
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

  const growthProjections = buildGrowthProjections({
    total,
    covers,
    webSharePercent,
    from,
    to,
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
    growthProjections,
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
  buildGrowthProjections,
  resolvePeriod,
  resolveTrialPeriod,
  formatPeriodLabel,
  formatTrialEndPhrase,
};
