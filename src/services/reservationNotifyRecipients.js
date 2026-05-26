'use strict';

const prisma = require('../lib/prisma');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EXTRA_EMAILS = 1;

const OWNER_KEY = 'owner';
const USER_KEY_PREFIX = 'user:';
const EXTRA_KEY_PREFIX = 'extra:';

const ORG_NOTIFY_SELECT = {
  id: true,
  name: true,
  reservationNotifyScope: true,
  reservationNotifyAudience: true,
  reservationNotifyCustomEmail: true,
  reservationNotifyRecipients: true,
  reservationNotifyOnWeb: true,
  reservationNotifyOnManual: true,
};

const RESTAURANT_NOTIFY_SELECT = {
  id: true,
  name: true,
  organizationId: true,
  reservationNotifyRecipients: true,
  reservationNotifyOnWeb: true,
  reservationNotifyOnManual: true,
};

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !EMAIL_REGEX.test(normalized)) return null;
  return normalized;
}

function addNormalizedEmail(set, email) {
  const normalized = normalizeEmail(email);
  if (normalized) set.add(normalized);
}

function displayName(user) {
  if (!user) return 'Sin nombre';
  const parts = [user.name, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : user.email || 'Sin nombre';
}

function userKey(userId) {
  return `${USER_KEY_PREFIX}${userId}`;
}

function extraKey(email) {
  return `${EXTRA_KEY_PREFIX}${normalizeEmail(email)}`;
}

function parseUserKey(key) {
  if (!key || !key.startsWith(USER_KEY_PREFIX)) return null;
  return key.slice(USER_KEY_PREFIX.length);
}

function parseExtraKey(key) {
  if (!key || !key.startsWith(EXTRA_KEY_PREFIX)) return null;
  return key.slice(EXTRA_KEY_PREFIX.length);
}

function emptyConfig() {
  return { owner: false, members: {}, extras: [] };
}

function normalizeStoredConfig(raw) {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  const members = {};
  if (raw.members && typeof raw.members === 'object') {
    for (const [userId, enabled] of Object.entries(raw.members)) {
      if (typeof userId === 'string' && userId && typeof enabled === 'boolean') {
        members[userId] = enabled;
      }
    }
  }
  const extras = [];
  if (Array.isArray(raw.extras)) {
    for (const email of raw.extras) {
      const normalized = normalizeEmail(email);
      if (normalized && !extras.includes(normalized)) extras.push(normalized);
    }
  }
  return {
    owner: raw.owner === true,
    members,
    extras: extras.slice(0, MAX_EXTRA_EMAILS),
  };
}

/**
 * @returns {Promise<{ owner: { userId: string, name: string, email: string|null }|null, members: Array<{ userId: string, name: string, email: string|null, role: string, roleLabel: string }> }>}
 */
async function loadRecipientCatalog(organizationId, restaurantId) {
  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    include: {
      owner: { select: { id: true, email: true, name: true, lastName: true } },
    },
  });

  const owner = org?.owner
    ? {
        userId: org.owner.id,
        name: displayName(org.owner),
        email: normalizeEmail(org.owner.email),
      }
    : null;

  const managers = await prisma.organizationManager.findMany({
    where: {
      organizationId,
      restaurantAssignments: { some: { restaurantId } },
    },
    include: { user: { select: { id: true, email: true, name: true, lastName: true } } },
  });

  const hosts = await prisma.organizationHost.findMany({
    where: {
      organizationId,
      restaurantAssignments: { some: { restaurantId } },
    },
    include: { user: { select: { id: true, email: true, name: true, lastName: true } } },
  });

  const members = [];
  const seenUserIds = new Set();

  for (const row of managers) {
    if (!row.user || seenUserIds.has(row.user.id)) continue;
    seenUserIds.add(row.user.id);
    members.push({
      userId: row.user.id,
      name: displayName(row.user),
      email: normalizeEmail(row.user.email),
      role: 'restaurant_manager',
      roleLabel: 'Gerente',
    });
  }

  for (const row of hosts) {
    if (!row.user || seenUserIds.has(row.user.id)) continue;
    seenUserIds.add(row.user.id);
    members.push({
      userId: row.user.id,
      name: displayName(row.user),
      email: normalizeEmail(row.user.email),
      role: 'restaurant_host',
      roleLabel: 'Anfitrión',
    });
  }

  members.sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { owner, members };
}

async function configFromLegacyAudience(audience, customEmail, organizationId, restaurantId) {
  const catalog = await loadRecipientCatalog(organizationId, restaurantId);
  const config = emptyConfig();

  if (audience === 'custom') {
    const email = normalizeEmail(customEmail);
    if (email) config.extras = [email];
    return config;
  }

  if (audience === 'owner' || audience === 'all') {
    config.owner = true;
  }

  if (audience === 'managers' || audience === 'all') {
    for (const member of catalog.members) {
      if (member.role === 'restaurant_manager') {
        config.members[member.userId] = true;
      }
    }
  }

  if (audience === 'hosts' || audience === 'all') {
    for (const member of catalog.members) {
      if (member.role === 'restaurant_host') {
        config.members[member.userId] = true;
      }
    }
  }

  return config;
}

function isNotifyConfigEmpty(config) {
  return (
    config.owner !== true &&
    Object.values(config.members).every((v) => v !== true) &&
    config.extras.length === 0
  );
}

/**
 * Configuración inicial por local: propietario + equipo asignado a esa sede.
 * Usar al registrar o al crear un local nuevo.
 */
async function buildInitialRestaurantNotifyRecipients(organizationId, restaurantId) {
  const catalog = await loadRecipientCatalog(organizationId, restaurantId);
  const members = {};
  for (const member of catalog.members) {
    members[member.userId] = true;
  }
  return {
    owner: Boolean(catalog.owner),
    members,
    extras: [],
  };
}

async function resolveEffectiveConfig(source, organizationId, restaurantId) {
  if (source.reservationNotifyRecipients) {
    return normalizeStoredConfig(source.reservationNotifyRecipients);
  }
  if (source.reservationNotifyAudience) {
    return configFromLegacyAudience(
      source.reservationNotifyAudience,
      source.reservationNotifyCustomEmail,
      organizationId,
      restaurantId,
    );
  }
  return emptyConfig();
}

/**
 * @returns {Promise<{ scope: string, config: object, onWeb: boolean, onManual: boolean, org: object, restaurant: object }>}
 */
async function loadNotifySettings(organizationId, restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: RESTAURANT_NOTIFY_SELECT,
  });

  if (!restaurant || restaurant.organizationId !== organizationId) {
    throw new Error('NOTIFY_SETTINGS_NOT_FOUND');
  }

  let config = await resolveEffectiveConfig(restaurant, organizationId, restaurantId);

  if (isNotifyConfigEmpty(config)) {
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      select: ORG_NOTIFY_SELECT,
    });
    if (org) {
      const fromOrg = await resolveEffectiveConfig(org, organizationId, restaurantId);
      if (!isNotifyConfigEmpty(fromOrg)) {
        config = fromOrg;
      }
    }
  }

  return {
    config,
    onWeb: restaurant.reservationNotifyOnWeb,
    onManual: restaurant.reservationNotifyOnManual,
    restaurant,
  };
}

function dedupeExtrasFromTeam(config, catalog) {
  const teamEmails = new Set();
  if (config.owner && catalog.owner?.email) {
    teamEmails.add(catalog.owner.email);
  }
  for (const member of catalog.members) {
    if (config.members[member.userId] === true && member.email) {
      teamEmails.add(member.email);
    }
  }
  return {
    ...config,
    extras: config.extras.filter((e) => !teamEmails.has(normalizeEmail(e))),
  };
}

function emailsFromConfig(config, catalog) {
  const deduped = dedupeExtrasFromTeam(config, catalog);
  const emails = new Set();

  if (deduped.owner && catalog.owner?.email) {
    addNormalizedEmail(emails, catalog.owner.email);
  }

  for (const member of catalog.members) {
    if (deduped.members[member.userId] === true && member.email) {
      addNormalizedEmail(emails, member.email);
    }
  }

  for (const extra of deduped.extras) {
    addNormalizedEmail(emails, extra);
  }

  return [...emails];
}

/**
 * @returns {Promise<string[]>}
 */
async function resolveReservationNotifyEmails(organizationId, restaurantId) {
  const { config } = await loadNotifySettings(organizationId, restaurantId);
  const catalog = await loadRecipientCatalog(organizationId, restaurantId);
  return emailsFromConfig(config, catalog);
}

/** @deprecated use resolveReservationNotifyEmails */
async function resolveReservationNotifyEmailsFromOrg(org, organizationId, restaurantId) {
  const config = await resolveEffectiveConfig(org, organizationId, restaurantId);
  const catalog = await loadRecipientCatalog(organizationId, restaurantId);
  return emailsFromConfig(config, catalog);
}

function buildRecipientRows(catalog, config) {
  const deduped = dedupeExtrasFromTeam(config, catalog);
  const rows = [];

  if (catalog.owner) {
    rows.push({
      key: OWNER_KEY,
      kind: 'owner',
      name: catalog.owner.name,
      email: catalog.owner.email,
      roleLabel: 'Propietario',
      enabled: deduped.owner === true,
      canEnable: Boolean(catalog.owner.email),
    });
  }

  for (const member of catalog.members) {
    rows.push({
      key: userKey(member.userId),
      kind: member.role === 'restaurant_manager' ? 'manager' : 'host',
      name: member.name,
      email: member.email,
      roleLabel: member.roleLabel,
      enabled: deduped.members[member.userId] === true,
      canEnable: Boolean(member.email),
    });
  }

  for (const email of deduped.extras) {
    rows.push({
      key: extraKey(email),
      kind: 'extra',
      name: 'Correo adicional',
      email,
      roleLabel: 'Correo externo',
      enabled: true,
      canEnable: true,
    });
  }

  return rows;
}

function activeRecipientsFromRows(rows) {
  return rows
    .filter((r) => r.enabled && r.email)
    .map((r) => ({
      email: r.email,
      name: r.name,
      roleLabel: r.roleLabel,
      kind: r.kind,
    }));
}

function activeEmailsFromRows(rows) {
  return activeRecipientsFromRows(rows).map((r) => r.email);
}

async function buildNotificationSettingsResponse(organizationId, restaurantId) {
  const notify = await loadNotifySettings(organizationId, restaurantId);
  const catalog = await loadRecipientCatalog(organizationId, restaurantId);
  const recipients = buildRecipientRows(catalog, notify.config);
  const activeRecipients = activeRecipientsFromRows(recipients);

  return {
    restaurantName: notify.restaurant.name,
    reservationNotifyOnWeb: notify.onWeb,
    reservationNotifyOnManual: notify.onManual,
    recipients,
    activeRecipients,
    activeEmails: activeRecipients.map((r) => r.email),
  };
}

function configFromRecipientPatchList(recipients, catalog) {
  const config = emptyConfig();
  const knownUserIds = new Set(catalog.members.map((m) => m.userId));
  const extraEmails = new Set();
  const teamEmails = new Set();

  if (catalog.owner?.email) teamEmails.add(catalog.owner.email);
  for (const member of catalog.members) {
    if (member.email) teamEmails.add(member.email);
  }

  if (!Array.isArray(recipients)) {
    throw new Error('INVALID_RECIPIENTS');
  }

  for (const row of recipients) {
    if (!row || typeof row.key !== 'string') continue;

    if (row.key === OWNER_KEY) {
      if (row.enabled === true) config.owner = true;
      continue;
    }

    const userId = parseUserKey(row.key);
    if (userId) {
      if (knownUserIds.has(userId) && row.enabled === true) {
        config.members[userId] = true;
      }
      continue;
    }

    const extraFromKey = parseExtraKey(row.key);
    const email = normalizeEmail(row.email ?? extraFromKey);
    if (!email) continue;

    if (row.enabled === true && !teamEmails.has(email)) {
      extraEmails.add(email);
    }
  }

  config.extras = [...extraEmails].slice(0, MAX_EXTRA_EMAILS);
  return dedupeExtrasFromTeam(config, catalog);
}

function findRecipientByEmail(recipients, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return recipients.find((r) => r.email && normalizeEmail(r.email) === normalized) ?? null;
}

function inferLegacyAudience(config, catalog) {
  const enabledManagerIds = catalog.members
    .filter((m) => m.role === 'restaurant_manager' && config.members[m.userId] === true)
    .map((m) => m.userId);
  const enabledHostIds = catalog.members
    .filter((m) => m.role === 'restaurant_host' && config.members[m.userId] === true)
    .map((m) => m.userId);
  const allManagerIds = catalog.members.filter((m) => m.role === 'restaurant_manager').map((m) => m.userId);
  const allHostIds = catalog.members.filter((m) => m.role === 'restaurant_host').map((m) => m.userId);

  const managersAll =
    allManagerIds.length > 0 &&
    allManagerIds.every((id) => enabledManagerIds.includes(id)) &&
    enabledManagerIds.length === allManagerIds.length;
  const hostsAll =
    allHostIds.length > 0 &&
    allHostIds.every((id) => enabledHostIds.includes(id)) &&
    enabledHostIds.length === allHostIds.length;

  if (config.extras.length > 0 && !config.owner && enabledManagerIds.length === 0 && enabledHostIds.length === 0) {
    return { audience: 'custom', customEmail: config.extras[0] ?? null };
  }

  if (config.owner && managersAll && hostsAll && config.extras.length === 0) {
    return { audience: 'all', customEmail: null };
  }
  if (config.owner && enabledManagerIds.length === 0 && enabledHostIds.length === 0 && config.extras.length === 0) {
    return { audience: 'owner', customEmail: null };
  }
  if (!config.owner && managersAll && enabledHostIds.length === 0 && config.extras.length === 0) {
    return { audience: 'managers', customEmail: null };
  }
  if (!config.owner && hostsAll && enabledManagerIds.length === 0 && config.extras.length === 0) {
    return { audience: 'hosts', customEmail: null };
  }

  return { audience: 'custom', customEmail: config.extras[0] ?? null };
}

function buildNotifyWritePayload(recipientConfig) {
  return {
    reservationNotifyRecipients: recipientConfig,
  };
}

/**
 * @returns {Promise<object>}
 */
async function saveNotifySettings(options) {
  const {
    organizationId,
    restaurantId,
    recipients,
    reservationNotifyOnWeb,
    reservationNotifyOnManual,
  } = options;

  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, organizationId, isDeleted: false },
    select: RESTAURANT_NOTIFY_SELECT,
  });
  if (!restaurant) throw new Error('NOTIFY_SETTINGS_NOT_FOUND');

  const catalog = await loadRecipientCatalog(organizationId, restaurantId);

  let recipientConfig;
  let onWeb = reservationNotifyOnWeb;
  let onManual = reservationNotifyOnManual;

  if (recipients !== undefined) {
    try {
      recipientConfig = configFromRecipientPatchList(recipients, catalog);
    } catch {
      throw new Error('INVALID_RECIPIENTS');
    }
  } else if (reservationNotifyOnWeb !== undefined || reservationNotifyOnManual !== undefined) {
    const current = await loadNotifySettings(organizationId, restaurantId);
    recipientConfig = current.config;
    if (onWeb === undefined) onWeb = current.onWeb;
    if (onManual === undefined) onManual = current.onManual;
  }

  const notifyPayload = recipientConfig ? buildNotifyWritePayload(recipientConfig) : {};
  const togglePayload = {};
  if (onWeb !== undefined) togglePayload.reservationNotifyOnWeb = onWeb;
  if (onManual !== undefined) togglePayload.reservationNotifyOnManual = onManual;

  const writePayload = { ...notifyPayload, ...togglePayload };

  if (Object.keys(writePayload).length === 0) {
    throw new Error('NOTHING_TO_UPDATE');
  }

  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: writePayload,
  });

  return buildNotificationSettingsResponse(organizationId, restaurantId);
}

module.exports = {
  EMAIL_REGEX,
  MAX_EXTRA_EMAILS,
  OWNER_KEY,
  userKey,
  extraKey,
  normalizeEmail,
  emptyConfig,
  normalizeStoredConfig,
  loadRecipientCatalog,
  configFromLegacyAudience,
  resolveEffectiveConfig,
  loadNotifySettings,
  resolveReservationNotifyEmails,
  resolveReservationNotifyEmailsFromOrg,
  buildRecipientRows,
  buildNotificationSettingsResponse,
  configFromRecipientPatchList,
  findRecipientByEmail,
  inferLegacyAudience,
  activeEmailsFromRows,
  activeRecipientsFromRows,
  dedupeExtrasFromTeam,
  saveNotifySettings,
  buildNotifyWritePayload,
  buildInitialRestaurantNotifyRecipients,
  isNotifyConfigEmpty,
};
