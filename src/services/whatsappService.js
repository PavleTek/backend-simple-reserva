/**
 * WhatsApp Business Cloud API (Meta) — sends approved template messages.
 * Credentials: DB Configuration row first, then env fallback:
 *   WHATSAPP_AUTH_TOKEN, WHATSAPP_SENDING_PHONE_NUMBER_ID, WHATSAPP_API_VERSION, WHATSAPP_TEMPLATE_LANGUAGE
 * @see docs/WHATSAPP_MESSAGE_TEMPLATES.md
 *
 * Logging: all lines prefixed with [WhatsApp]. Set WHATSAPP_VERBOSE_LOG=false to hide info/debug lines
 * (errors and warnings are always printed).
 */

const prisma = require('../lib/prisma');

const GRAPH_BASE = 'https://graph.facebook.com';

/** If not 'false', log config resolution, send attempts, sync pages, etc. */
const VERBOSE = process.env.WHATSAPP_VERBOSE_LOG !== 'false';

function logInfo(msg, extra) {
  if (!VERBOSE) return;
  if (extra !== undefined) {
    console.log(`[WhatsApp] ${msg}`, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 0));
  } else {
    console.log(`[WhatsApp] ${msg}`);
  }
}

function logWarn(msg, extra) {
  if (extra !== undefined) {
    console.warn(`[WhatsApp] ${msg}`, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 0));
  } else {
    console.warn(`[WhatsApp] ${msg}`);
  }
}

function logError(msg, extra) {
  if (extra !== undefined) {
    console.error(`[WhatsApp] ${msg}`, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 0));
  } else {
    console.error(`[WhatsApp] ${msg}`);
  }
}

/**
 * Safe stringify of Meta Graph error payloads (full detail for debugging).
 * @param {unknown} data
 */
function formatMetaResponse(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * @param {string} phoneE164 - E.164 e.g. +56912345678
 * @returns {string|null} digits only for Meta API `to` field
 */
function normalizeToWhatsAppRecipient(phoneE164) {
  if (!phoneE164 || typeof phoneE164 !== 'string') return null;
  const digits = phoneE164.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/**
 * Resolved credentials for API calls (never log full token).
 * @returns {Promise<{ token: string|null, phoneId: string|null, version: string, templateLanguage: string, wabaId: string|null }>}
 */
async function getWhatsAppConfig() {
  let row = null;
  try {
    row = await prisma.configuration.findFirst();
  } catch (e) {
    logError('Failed to load Configuration from database', {
      message: e instanceof Error ? e.message : String(e),
      code: e && e.code,
    });
    row = null;
  }

  let tokenSource = 'none';
  let token = null;
  if (row?.whatsappAuthToken && String(row.whatsappAuthToken).trim()) {
    token = String(row.whatsappAuthToken).trim();
    tokenSource = 'database(Configuration.whatsappAuthToken)';
  } else if (process.env.WHATSAPP_AUTH_TOKEN) {
    token = process.env.WHATSAPP_AUTH_TOKEN;
    tokenSource = 'env(WHATSAPP_AUTH_TOKEN)';
  } else if (process.env.WHATSAPP_API_TOKEN) {
    token = process.env.WHATSAPP_API_TOKEN;
    tokenSource = 'env(WHATSAPP_API_TOKEN) [legacy name — prefer WHATSAPP_AUTH_TOKEN]';
  }

  let phoneSource = 'none';
  let phoneId = null;
  if (row?.whatsappSendingPhoneNumberId && String(row.whatsappSendingPhoneNumberId).trim()) {
    phoneId = String(row.whatsappSendingPhoneNumberId).trim();
    phoneSource = 'database(Configuration.whatsappSendingPhoneNumberId)';
  } else if (process.env.WHATSAPP_SENDING_PHONE_NUMBER_ID) {
    phoneId = process.env.WHATSAPP_SENDING_PHONE_NUMBER_ID.trim();
    phoneSource = 'env(WHATSAPP_SENDING_PHONE_NUMBER_ID)';
  } else if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
    phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID.trim();
    phoneSource = 'env(WHATSAPP_PHONE_NUMBER_ID) [legacy name — prefer WHATSAPP_SENDING_PHONE_NUMBER_ID]';
  }

  const version =
    (row?.whatsappApiVersion && String(row.whatsappApiVersion).trim()) ||
    process.env.WHATSAPP_API_VERSION ||
    'v21.0';

  const versionSource =
    row?.whatsappApiVersion?.trim() ? 'database' : process.env.WHATSAPP_API_VERSION ? 'env' : 'default';

  const templateLanguage =
    (row?.whatsappTemplateLanguage && String(row.whatsappTemplateLanguage).trim()) ||
    process.env.WHATSAPP_TEMPLATE_LANGUAGE ||
    'es';

  const wabaId =
    (row?.whatsappBusinessAccountId && String(row.whatsappBusinessAccountId).trim()) || null;

  logInfo('Config resolved', {
    tokenSource,
    tokenPreview: maskToken(token),
    phoneNumberIdSource: phoneSource,
    sendingPhoneNumberId: phoneId || '(missing)',
    graphApiVersion: version,
    versionSource,
    defaultTemplateLanguage: templateLanguage,
    wabaId: wabaId || '(not set — required only for template sync)',
    wabaFromDatabase: !!row?.whatsappBusinessAccountId?.trim(),
  });

  return {
    token: token || null,
    phoneId: phoneId || null,
    version,
    templateLanguage,
    wabaId,
  };
}

/**
 * @param {string|null|undefined} token
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.length <= 4) return '****';
  return `****…${token.slice(-4)}`;
}

async function isWhatsAppConfigured() {
  const c = await getWhatsAppConfig();
  return !!(c.token && c.phoneId);
}

/**
 * @param {object[]} components
 * @returns {string|null}
 */
function extractBodyTextFromComponents(components) {
  if (!Array.isArray(components)) return null;
  const body = components.find((c) => c.type === 'BODY');
  if (!body || !body.text) return null;
  return body.text;
}

/**
 * Send a template message with body placeholders {{1}}, {{2}}, … in order.
 * @param {string} toE164 - E.164 recipient
 * @param {string} templateName - approved template name in Meta
 * @param {string} [languageCode] - overrides default template language
 * @param {string[]} bodyParameters - values for body variables in order
 * @returns {Promise<boolean>}
 */
async function sendWhatsAppTemplate(toE164, templateName, languageCode, bodyParameters) {
  logInfo('sendWhatsAppTemplate: start', {
    templateName,
    languageOverride: languageCode ?? '(use default from config)',
    paramCount: (bodyParameters || []).length,
  });

  const { token, phoneId, version, templateLanguage } = await getWhatsAppConfig();
  const lang = languageCode || templateLanguage || 'es';

  if (!token || !phoneId) {
    logWarn('Cannot send: missing auth token or sending phone number ID. Check Admin → WhatsApp or env vars.', {
      hasToken: !!token,
      hasSendingPhoneNumberId: !!phoneId,
    });
    return false;
  }

  const to = normalizeToWhatsAppRecipient(toE164);
  if (!to) {
    logWarn('Cannot send: invalid E.164 recipient after normalization', {
      inputPreview: typeof toE164 === 'string' ? `${toE164.slice(0, 6)}…` : String(toE164),
    });
    return false;
  }

  const url = `${GRAPH_BASE}/${version}/${phoneId}/messages`;
  logInfo('POST /messages', {
    endpoint: `${GRAPH_BASE}/${version}/{sendingPhoneNumberId}/messages`,
    sendingPhoneNumberId: phoneId,
    graphVersion: version,
    templateName,
    templateLanguage: lang,
    toDigits: `…${to.slice(-4)}`,
  });

  const parameters = (bodyParameters || []).map((text) => ({
    type: 'text',
    text: String(text ?? ''),
  }));

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: [{ type: 'body', parameters }],
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch((parseErr) => {
      logError('Response body is not JSON', { message: parseErr?.message });
      return {};
    });

    if (!res.ok) {
      logError(`Graph API error HTTP ${res.status} for POST /${version}/${phoneId}/messages`, {
        status: res.status,
        statusText: res.statusText,
        body: formatMetaResponse(data),
        hints: [
          'Common causes: invalid/expired token, wrong Phone Number ID, template name/language mismatch, recipient not allowed in dev mode.',
          'See error.error_user_msg, error.code, error.error_subcode, fbtrace_id in body above.',
        ],
      });
      return false;
    }

    const wamid = data.messages?.[0]?.id;
    logInfo('Template message accepted by Meta', {
      templateName,
      wamid: wamid || '(no id in response)',
      ...(VERBOSE ? { rawResponse: formatMetaResponse(data) } : {}),
    });
    return true;
  } catch (err) {
    logError('Network or fetch failure sending template', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return false;
  }
}

/**
 * Send Meta's built-in hello_world test template (no parameters, language en_US).
 * Use this for quick testing before custom templates are approved.
 * @param {string} toE164
 */
async function sendHelloWorldWA(toE164) {
  return sendWhatsAppTemplate(toE164, 'hello_world', 'en_US', []);
}

/** @param {string} toE164 */
async function sendReservationConfirmationWA(
  toE164,
  restaurantName,
  dateStr,
  timeStr,
  partySize,
  manageLink
) {
  return sendWhatsAppTemplate(toE164, 'reservation_confirmation', undefined, [
    restaurantName,
    dateStr,
    timeStr,
    String(partySize),
    manageLink,
  ]);
}

/** @param {string} toE164 */
async function sendReservationReminderWA(
  toE164,
  restaurantName,
  timeStr,
  partySize,
  manageLink
) {
  return sendWhatsAppTemplate(toE164, 'reservation_reminder', undefined, [
    restaurantName,
    timeStr,
    String(partySize),
    manageLink,
  ]);
}

/** @param {string} toE164 */
async function sendReservationModifiedWA(
  toE164,
  restaurantName,
  dateStr,
  timeStr,
  partySize
) {
  return sendWhatsAppTemplate(toE164, 'reservation_modified', undefined, [
    restaurantName,
    dateStr,
    timeStr,
    String(partySize),
  ]);
}

/** @param {string} toE164 */
async function sendReservationCancelledWA(toE164, restaurantName) {
  return sendWhatsAppTemplate(toE164, 'reservation_cancelled', undefined, [restaurantName]);
}

/**
 * Verify token and phone number ID against Meta.
 * @returns {Promise<{ connected: boolean, phoneNumber?: string, verifiedName?: string, error?: string }>}
 */
async function testWhatsAppConnection() {
  logInfo('testWhatsAppConnection: start');
  const { token, phoneId, version } = await getWhatsAppConfig();
  if (!token || !phoneId) {
    const err = 'Falta token de autenticación o ID del número de envío';
    logWarn(`testWhatsAppConnection: ${err}`, { hasToken: !!token, hasPhoneId: !!phoneId });
    return {
      connected: false,
      error: err,
    };
  }

  const url = `${GRAPH_BASE}/${version}/${phoneId}?fields=display_phone_number,verified_name`;
  logInfo('GET phone number object (connection test)', {
    url,
    note: 'Token is only in Authorization header, not in URL',
  });

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch((e) => {
      logError('testWhatsAppConnection: failed to parse JSON', { message: e?.message });
      return {};
    });

    if (!res.ok) {
      logError(`testWhatsAppConnection: HTTP ${res.status}`, {
        status: res.status,
        body: formatMetaResponse(data),
      });
      return {
        connected: false,
        error: data.error?.message || `HTTP ${res.status}`,
      };
    }

    logInfo('testWhatsAppConnection: success', {
      display_phone_number: data.display_phone_number,
      verified_name: data.verified_name,
    });
    return {
      connected: true,
      phoneNumber: data.display_phone_number || undefined,
      verifiedName: data.verified_name || undefined,
    };
  } catch (err) {
    logError('testWhatsAppConnection: request failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { connected: false, error: err.message };
  }
}

/**
 * Fetch message templates from Meta WABA and upsert into DB.
 * @returns {Promise<{ ok: boolean, templates?: object[], error?: string }>}
 */
async function syncTemplatesFromMeta() {
  logInfo('syncTemplatesFromMeta: start');
  const { token, version, wabaId } = await getWhatsAppConfig();
  if (!token) {
    logWarn('syncTemplatesFromMeta: abort — no auth token');
    return { ok: false, error: 'Falta token de autenticación' };
  }
  if (!wabaId) {
    logWarn('syncTemplatesFromMeta: abort — no WABA ID (set in Admin → WhatsApp)');
    return { ok: false, error: 'Falta ID de cuenta de WhatsApp Business (WABA)' };
  }

  const all = [];
  let page = 0;
  let nextUrl = `${GRAPH_BASE}/${version}/${wabaId}/message_templates?limit=100`;
  logInfo('First request URL pattern', {
    describe: `GET ${GRAPH_BASE}/${version}/{wabaId}/message_templates?limit=100`,
    wabaId,
  });

  try {
    while (nextUrl) {
      page += 1;
      logInfo(`syncTemplatesFromMeta: fetching page ${page}`, { url: nextUrl.split('?')[0] + '?…' });

      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch((e) => {
        logError(`syncTemplatesFromMeta: page ${page} invalid JSON`, { message: e?.message });
        return {};
      });

      if (!res.ok) {
        logError(`syncTemplatesFromMeta: Graph API HTTP ${res.status} on page ${page}`, {
          status: res.status,
          body: formatMetaResponse(data),
          hint: 'Check WABA ID, token permissions (whatsapp_business_management), and app access to the business.',
        });
        return {
          ok: false,
          error: data.error?.message || `HTTP ${res.status}`,
        };
      }

      const batch = data.data || [];
      logInfo(`syncTemplatesFromMeta: page ${page} received ${batch.length} template(s)`);
      all.push(...batch);
      nextUrl = data.paging?.next || null;
      if (nextUrl) {
        logInfo('syncTemplatesFromMeta: more pages (paging.next present)');
      }
    }
  } catch (err) {
    logError('syncTemplatesFromMeta: request loop failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err.message };
  }

  logInfo(`syncTemplatesFromMeta: total templates from Meta: ${all.length}`);

  const now = new Date();
  let upsertOk = 0;
  let upsertErr = 0;

  for (const t of all) {
    const metaId = t.id != null ? String(t.id) : null;
    const name = t.name != null ? String(t.name) : '';
    const language = t.language != null ? String(t.language) : 'es';
    const category = t.category != null ? String(t.category) : null;
    const status = t.status != null ? String(t.status) : null;
    const bodyText = extractBodyTextFromComponents(t.components);
    const componentsJson = t.components ? t.components : null;

    if (!name) {
      logWarn('syncTemplatesFromMeta: skipping template with empty name', { metaId });
      continue;
    }

    try {
      if (metaId) {
        await prisma.whatsAppTemplate.upsert({
          where: { metaId },
          create: {
            metaId,
            name,
            language,
            category,
            status,
            bodyText,
            componentsJson,
            lastSyncedAt: now,
          },
          update: {
            name,
            language,
            category,
            status,
            bodyText,
            componentsJson,
            lastSyncedAt: now,
          },
        });
      } else {
        await prisma.whatsAppTemplate.upsert({
          where: {
            name_language: { name, language },
          },
          create: {
            metaId: null,
            name,
            language,
            category,
            status,
            bodyText,
            componentsJson,
            lastSyncedAt: now,
          },
          update: {
            category,
            status,
            bodyText,
            componentsJson,
            lastSyncedAt: now,
          },
        });
      }
      upsertOk += 1;
    } catch (dbErr) {
      upsertErr += 1;
      logError(`syncTemplatesFromMeta: upsert failed for template "${name}"`, {
        message: dbErr instanceof Error ? dbErr.message : String(dbErr),
        code: dbErr && dbErr.code,
        metaId,
      });
    }
  }

  logInfo('syncTemplatesFromMeta: DB upsert summary', { upsertOk, upsertErr, totalFromApi: all.length });

  const templates = await prisma.whatsAppTemplate.findMany({
    orderBy: [{ name: 'asc' }, { language: 'asc' }],
  });
  logInfo(`syncTemplatesFromMeta: done — ${templates.length} row(s) in DB`);
  return { ok: true, templates };
}

/**
 * Create a new message template on Meta via the WABA management API.
 * @param {{ name: string, category: string, language: string, bodyText: string, headerText?: string, footerText?: string }} params
 * @returns {Promise<{ ok: boolean, metaId?: string, status?: string, error?: string }>}
 */
async function createTemplateOnMeta({ name, category, language, bodyText, headerText, footerText }) {
  logInfo('createTemplateOnMeta: start', { name, category, language });
  const { token, version, wabaId } = await getWhatsAppConfig();

  if (!token) {
    logWarn('createTemplateOnMeta: abort — no auth token');
    return { ok: false, error: 'Falta token de autenticación' };
  }
  if (!wabaId) {
    logWarn('createTemplateOnMeta: abort — no WABA ID (set in Admin → WhatsApp)');
    return { ok: false, error: 'Falta ID de cuenta de WhatsApp Business (WABA)' };
  }

  const components = [];
  if (headerText && headerText.trim()) {
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText.trim() });
  }
  components.push({ type: 'BODY', text: bodyText });
  if (footerText && footerText.trim()) {
    components.push({ type: 'FOOTER', text: footerText.trim() });
  }

  const url = `${GRAPH_BASE}/${version}/${wabaId}/message_templates`;
  const payload = { name, language, category, components };

  logInfo('createTemplateOnMeta: POST', {
    endpoint: `${GRAPH_BASE}/${version}/{wabaId}/message_templates`,
    name,
    category,
    language,
    componentTypes: components.map((c) => c.type),
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch((e) => {
      logError('createTemplateOnMeta: failed to parse JSON response', { message: e?.message });
      return {};
    });

    if (!res.ok) {
      logError(`createTemplateOnMeta: Graph API HTTP ${res.status}`, {
        status: res.status,
        body: formatMetaResponse(data),
        hint: 'Common causes: name already exists, invalid category, or missing whatsapp_business_management permission.',
      });
      return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
    }

    logInfo('createTemplateOnMeta: success', {
      metaId: data.id,
      status: data.status,
    });
    return { ok: true, metaId: data.id ? String(data.id) : undefined, status: data.status };
  } catch (err) {
    logError('createTemplateOnMeta: request failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = {
  normalizeToWhatsAppRecipient,
  maskToken,
  getWhatsAppConfig,
  isWhatsAppConfigured,
  sendWhatsAppTemplate,
  sendReservationConfirmationWA,
  sendReservationReminderWA,
  sendReservationModifiedWA,
  sendReservationCancelledWA,
  testWhatsAppConnection,
  syncTemplatesFromMeta,
  createTemplateOnMeta,
  sendHelloWorldWA,
};
