/**
 * Reservation confirmations and reminders via SMS (Twilio) and WhatsApp (Meta Cloud API).
 * SMS: optional if TWILIO_* env vars are not set.
 * WhatsApp: optional if not configured (DB admin config or WHATSAPP_* env fallback); gated by Plan.whatsappFeatures.
 */

const { formatTime, formatDateDisplay } = require('../utils/dateFormat');
const { getEffectiveTimezone } = require('../utils/timezone');
const {
  sendHelloWorldWA,
} = require('./whatsappService');

/**
 * Normalizes phone to E.164 format for Twilio.
 * Accepts: Chilean numbers (legacy) and international E.164 (e.g. +34912345678).
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  // Already E.164 (starts with +, 10-15 digits)
  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return trimmed;
    return null;
  }
  // Legacy Chilean formats
  const cleaned = trimmed.replace(/\D/g, '');
  if (cleaned.startsWith('56') && cleaned.length >= 9) return `+${cleaned}`;
  if (cleaned.length === 9 && cleaned.startsWith('9')) return `+56${cleaned}`;
  if (cleaned.length === 8) return `+569${cleaned}`;
  return null;
}

/**
 * Public marketing / user booking site (reservation links, SMS, email).
 * Supports legacy typo FRONTEND_LANDING_PAGE_URL and correct FRONTEND_LANDING_PAGE_URL.
 */
function getBaseUrl() {
  return (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'http://localhost:5173'
  );
}

async function sendSmsTwilio(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.log('[Notification] Twilio not configured, skipping SMS');
    return false;
  }

  try {
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      body,
      from: fromNumber,
      to,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Twilio SMS error:', err.message);
    return false;
  }
}

/**
 * Send reservation confirmation SMS and WhatsApp to the customer.
 * @param {Object} options
 * @param {string} options.customerPhone - Customer phone (Chilean format)
 * @param {string} options.restaurantName - Restaurant name
 * @param {Date|string} options.dateTime - Reservation date/time
 * @param {number} options.partySize - Party size
 * @param {string} options.secureToken - Self-service token
 * @param {string} [options.restaurantId] - For plan check (WhatsApp gated by whatsappConfirmations)
 * @returns {Promise<boolean>} - true if at least one channel sent, false otherwise
 */
async function sendReservationConfirmation(options) {
  const {
    customerPhone,
    restaurantName,
    dateTime,
    partySize,
    secureToken,
    restaurantId,
  } = options;

  const to = normalizePhone(customerPhone);
  if (!to) {
    console.warn('[Notification] Invalid phone for SMS:', customerPhone);
    return false;
  }

  let timezone = null;
  if (restaurantId) {
    const prisma = require('../lib/prisma');
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: {
          include: {
            owner: { select: { country: true } }
          }
        }
      }
    });
    if (restaurant) {
      const ownerCountry = restaurant.organization?.owner?.country || 'CL';
      timezone = getEffectiveTimezone(restaurant, ownerCountry);
    }
  }

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt, timezone);
  const timeStr = formatTime(dt, timezone);

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const link = `${baseUrl}/reservation/${secureToken}`;

  const body = [
    `SimpleReserva: Tu reserva en ${restaurantName} está confirmada.`,
    `${dateStr} a las ${timeStr} para ${partySize} persona(s).`,
    `Ver o cancelar: ${link}`,
  ].join('\n');

  const smsOk = await sendSmsTwilio(to, body);
  let waOk = false;
  if (restaurantId) {
    const planService = require('./planService');
    const config = await planService.resolvePlanConfigForRestaurant(restaurantId, true);
    if (config?.whatsappFeatures) {
      console.log(
        `[Notification] WhatsApp confirmation: sending hello_world (restaurantId=${restaurantId}, plan=${config.productSKU || config.name || 'n/a'})`
      );
      waOk = await sendHelloWorldWA(to);
      if (!waOk) {
        console.warn(
          `[Notification] WhatsApp confirmation failed or skipped for restaurantId=${restaurantId} — see [WhatsApp] logs above for Meta error details`
        );
      }
    } else {
      console.log(
        `[Notification] WhatsApp confirmation skipped: Plan.whatsappFeatures is false (restaurantId=${restaurantId})`
      );
    }
  } else {
    console.log('[Notification] WhatsApp confirmation: sending hello_world (no restaurantId — plan check skipped)');
    waOk = await sendHelloWorldWA(to);
    if (!waOk) {
      console.warn(
        '[Notification] WhatsApp confirmation failed or skipped — see [WhatsApp] logs above'
      );
    }
  }
  return smsOk || waOk;
}

/**
 * Send day-before reminder SMS and WhatsApp.
 * @param {Object} options
 * @param {string} [options.restaurantId] - For plan check (WhatsApp gated by whatsappReminders)
 */
async function sendReservationReminder(options) {
  const {
    customerPhone,
    restaurantName,
    dateTime,
    partySize,
    secureToken,
    restaurantId,
  } = options;

  const to = normalizePhone(customerPhone);
  if (!to) return false;

  let timezone = null;
  if (restaurantId) {
    const prisma = require('../lib/prisma');
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: {
          include: {
            owner: { select: { country: true } }
          }
        }
      }
    });
    if (restaurant) {
      const ownerCountry = restaurant.organization?.owner?.country || 'CL';
      timezone = getEffectiveTimezone(restaurant, ownerCountry);
    }
  }

  const dt = new Date(dateTime);
  const timeStr = formatTime(dt, timezone);

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const link = `${baseUrl}/reservation/${secureToken}`;

  const body = [
    `Recordatorio: Tienes reserva mañana en ${restaurantName} a las ${timeStr} para ${partySize} persona(s).`,
    `Confirmar o cancelar: ${link}`,
  ].join('\n');

  const smsOk = await sendSmsTwilio(to, body);
  let waOk = false;
  if (restaurantId) {
    const planService = require('./planService');
    const config = await planService.resolvePlanConfigForRestaurant(restaurantId, true);
    if (config?.whatsappFeatures) {
      console.log(`[Notification] WhatsApp reminder: sending hello_world (restaurantId=${restaurantId})`);
      waOk = await sendHelloWorldWA(to);
      if (!waOk) {
        console.warn(
          `[Notification] WhatsApp reminder failed — see [WhatsApp] logs (restaurantId=${restaurantId})`
        );
      }
    } else {
      console.log(
        `[Notification] WhatsApp reminder skipped: whatsappFeatures=false (restaurantId=${restaurantId})`
      );
    }
  } else {
    console.log('[Notification] WhatsApp reminder: sending hello_world (no restaurantId)');
    waOk = await sendHelloWorldWA(to);
    if (!waOk) console.warn('[Notification] WhatsApp reminder failed — see [WhatsApp] logs');
  }
  return smsOk || waOk;
}

/**
 * Send modification/cancellation alert to customer via WhatsApp.
 * Used when customer modifies or cancels their reservation.
 * @param {Object} options
 * @param {string} options.customerPhone - Customer phone
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.type - 'cancelled' | 'modified'
 * @param {Date|string} [options.dateTime] - For modified: new date/time
 * @param {number} [options.partySize] - For modified: new party size
 * @param {string} [options.restaurantId] - For plan check (whatsappModificationAlerts)
 */
async function sendModificationAlertToCustomer(options) {
  const { customerPhone, restaurantName, type, dateTime, partySize, restaurantId } = options;
  const to = normalizePhone(customerPhone);
  if (!to) return false;

  let timezone = null;
  if (restaurantId) {
    const prisma = require('../lib/prisma');
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        organization: {
          include: {
            owner: { select: { country: true } }
          }
        }
      }
    });
    if (restaurant) {
      const ownerCountry = restaurant.organization?.owner?.country || 'CL';
      timezone = getEffectiveTimezone(restaurant, ownerCountry);
    }
  }

  if (restaurantId) {
    const planService = require('./planService');
    const config = await planService.resolvePlanConfigForRestaurant(restaurantId, true);
    if (!config?.whatsappFeatures) {
      console.log(
        `[Notification] WhatsApp modification alert skipped: whatsappFeatures=false (restaurantId=${restaurantId})`
      );
      return false;
    }
  }

  if (type === 'cancelled') {
    console.log(`[Notification] WhatsApp cancel alert: sending hello_world (type=cancelled)`);
    const ok = await sendHelloWorldWA(to);
    if (!ok) console.warn('[Notification] WhatsApp cancel alert failed — see [WhatsApp] logs');
    return ok;
  }
  if (type === 'modified' && dateTime && partySize) {
    console.log(`[Notification] WhatsApp modify alert: sending hello_world (type=modified)`);
    const ok = await sendHelloWorldWA(to);
    if (!ok) console.warn('[Notification] WhatsApp modify alert failed — see [WhatsApp] logs');
    return ok;
  }
  console.warn('[Notification] WhatsApp modification alert: invalid type or missing dateTime/partySize', {
    type,
  });
  return false;
}

/**
 * Send daily reservation summary to restaurant owner/admin.
 * @param {Object} options
 * @param {string} options.email - Owner/admin email
 * @param {string} options.restaurantName - Restaurant name
 * @param {number} options.count - Number of reservations today
 * @param {string|null} options.firstTime - First reservation time (e.g. "12:30")
 * @param {string} options.panelUrl - Link to view reservations
 */
/**
 * HTML welcome email for new restaurant organization owners.
 * @param {Object} options
 * @param {string} options.email - Owner email address
 * @param {string} options.ownerName - Owner's display name (full name or email fallback)
 * @param {string} options.panelUrl - URL to the restaurant management portal
 * @returns {Promise<boolean>}
 */
async function sendOrganizationOwnerWelcomeEmail({ email, ownerName, panelUrl }) {
  if (!email) return false;

  const { buildOrganizationOwnerWelcomeHtml } = require('../templates/restaurantOrganizationOwnerWelcomeEmail');
  const { sendEmail } = require('./emailService');
  const { CONTACT_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_HREF } = require('../config/contact');
  const prisma = require('../lib/prisma');

  const config = await prisma.configuration.findFirst();
  const fromSenderId = config?.reservationEmailSenderId || config?.recoveryEmailSenderId;
  const fromSender = fromSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: fromSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  const baseUrl = getBaseUrl().replace(/\/$/, '');

  const html = buildOrganizationOwnerWelcomeHtml({
    ownerName,
    panelUrl,
    contactEmail: CONTACT_EMAIL,
    whatsappDisplay: WHATSAPP_DISPLAY,
    whatsappHref: WHATSAPP_HREF,
    assetBaseUrl: baseUrl,
  });

  try {
    await sendEmail({
      fromEmail,
      toEmails: [email],
      subject: 'Bienvenido a SimpleReserva — tu cuenta está lista',
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Welcome email error:', err.message);
    return false;
  }
}

function getEmailAssetBaseUrl() {
  return (
    process.env.FRONTEND_LANDING_PAGE_URL ||
    process.env.FRONTEND_LANDING_PAGE_URL ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
}

async function resolveTransactionalFromEmail() {
  const prisma = require('../lib/prisma');
  const config = await prisma.configuration.findFirst();
  const fromSenderId = config?.reservationEmailSenderId || config?.recoveryEmailSenderId;
  const fromSender = fromSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: fromSenderId } }))?.email
    : null;
  return fromSender || 'noreply@simplereserva.com';
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addNormalizedEmail(set, email) {
  if (!email || typeof email !== 'string') return;
  const normalized = email.trim().toLowerCase();
  if (normalized && EMAIL_REGEX.test(normalized)) {
    set.add(normalized);
  }
}

/**
 * Resolve notification recipient emails for a new reservation alert.
 * @param {Object} options
 * @param {string} options.organizationId
 * @param {string} options.restaurantId
 * @param {'owner'|'managers'|'hosts'|'all'|'custom'} options.audience
 * @param {string|null} [options.customEmail]
 * @returns {Promise<string[]>}
 */
async function resolveReservationNotifyEmails(options) {
  const { organizationId, restaurantId, audience, customEmail } = options;
  const prisma = require('../lib/prisma');
  const emails = new Set();

  if (audience === 'custom') {
    addNormalizedEmail(emails, customEmail);
    return [...emails];
  }

  if (audience === 'owner' || audience === 'all') {
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: organizationId },
      include: { owner: { select: { email: true } } },
    });
    if (audience === 'owner' && !org) return [];
    addNormalizedEmail(emails, org?.owner?.email);
  }

  if (audience === 'managers' || audience === 'all') {
    const managers = await prisma.organizationManager.findMany({
      where: {
        organizationId,
        restaurantAssignments: { some: { restaurantId } },
      },
      include: { user: { select: { email: true } } },
    });
    for (const manager of managers) {
      addNormalizedEmail(emails, manager.user?.email);
    }
  }

  if (audience === 'hosts' || audience === 'all') {
    const hosts = await prisma.organizationHost.findMany({
      where: {
        organizationId,
        restaurantAssignments: { some: { restaurantId } },
      },
      include: { user: { select: { email: true } } },
    });
    for (const host of hosts) {
      addNormalizedEmail(emails, host.user?.email);
    }
  }

  return [...emails];
}

/**
 * Send new reservation alert email to restaurant team.
 * @returns {Promise<boolean>}
 */
async function sendNewReservationAlertEmail(options) {
  const {
    emails,
    restaurantName,
    customerName,
    customerPhone = null,
    customerEmail = null,
    dateTime,
    partySize,
    panelUrl,
    timezone = null,
    source = 'web',
    organizationId,
    restaurantId,
    audience,
  } = options;

  if (!emails || emails.length === 0) {
    console.log('[Notification] sendNewReservationAlertEmail: skipped — no recipients', {
      organizationId,
      restaurantId,
      audience,
    });
    return false;
  }

  const dt = new Date(dateTime);
  const tz = timezone || undefined;
  const dateStr = formatDateDisplay(dt, tz);
  const timeStr = formatTime(dt, tz);
  const { formatDateShortLabel } = require('../utils/dateFormat');
  const dateShort = formatDateShortLabel(dt, tz || 'America/Santiago');
  const sourceLabel = source === 'manual' ? 'Reserva manual (panel)' : 'Reserva web';

  const {
    buildNewReservationNotificationHtml,
    buildNewReservationSubject,
  } = require('../templates/newReservationNotificationEmail');
  const { sendEmail } = require('./emailService');

  const subject = buildNewReservationSubject({
    customerName,
    restaurantName,
    timeStr,
    dateShort,
    partySize,
  });
  const html = buildNewReservationNotificationHtml({
    restaurantName,
    customerName,
    customerPhone,
    customerEmail,
    dateStr,
    timeStr,
    dateShort,
    partySize,
    panelUrl,
    sourceLabel,
    assetBaseUrl: getEmailAssetBaseUrl(),
  });

  try {
    const fromEmail = await resolveTransactionalFromEmail();
    const result = await sendEmail({
      fromEmail,
      toEmails: emails,
      subject,
      content: html,
      isHtml: true,
    });
    console.log('[Notification] sendNewReservationAlertEmail: sent OK', {
      organizationId,
      restaurantId,
      audience,
      recipientCount: emails.length,
      resendId: result?.data?.id || result?.id || '(no id)',
    });
    return true;
  } catch (err) {
    console.error('[Notification] sendNewReservationAlertEmail: FAILED', {
      organizationId,
      restaurantId,
      audience,
      recipientCount: emails.length,
      message: err.message,
      statusCode: err?.statusCode,
    });
    return false;
  }
}

const TEAM_NOTIFY_SKIP = {
  SETTINGS_DISABLED: 'settings_disabled',
  NO_RECIPIENTS: 'no_recipients',
  SEND_FAILED: 'send_failed',
};

async function persistTeamNotifyOutcome(reservationId, outcome) {
  if (!reservationId) return;
  const prisma = require('../lib/prisma');
  const { sent, recipients = [], skipReason = null } = outcome;
  await prisma.reservation
    .update({
      where: { id: reservationId },
      data: {
        teamNotifySent: sent,
        teamNotifySentAt: sent ? new Date() : null,
        teamNotifyRecipients: recipients,
        teamNotifySkipReason: skipReason,
      },
    })
    .catch((err) => console.error('[Notification] teamNotify outcome update failed:', err.message));
}

/**
 * Notify restaurant team about a new reservation (respects org settings).
 * Does not depend on canSendConfirmations.
 */
async function notifyRestaurantNewReservation(options) {
  const {
    reservationId = null,
    source,
    organizationId,
    restaurantId,
    restaurantName,
    customerName,
    customerPhone = null,
    customerEmail = null,
    dateTime,
    partySize,
    timezone = null,
  } = options;

  const prisma = require('../lib/prisma');
  const { reservationsListUrl } = require('../utils/restaurantPanelUrl');
  const { formatInTimezone } = require('../utils/timezone');
  const { loadNotifySettings, resolveReservationNotifyEmails } = require('./reservationNotifyRecipients');

  const recordOutcome = (outcome) => persistTeamNotifyOutcome(reservationId, outcome);

  let notify;
  try {
    notify = await loadNotifySettings(organizationId, restaurantId);
  } catch {
    return false;
  }

  const shouldNotifyTeam =
    (source === 'web' && notify.onWeb) ||
    (source === 'manual' && notify.onManual);

  if (!shouldNotifyTeam) {
    console.log('[Notification] notifyRestaurantNewReservation: skipped by settings', {
      organizationId,
      restaurantId,
      source,
    });
    await recordOutcome({
      sent: false,
      recipients: [],
      skipReason: TEAM_NOTIFY_SKIP.SETTINGS_DISABLED,
    });
    return false;
  }

  const emails = await resolveReservationNotifyEmails(organizationId, restaurantId);

  if (!emails || emails.length === 0) {
    console.log('[Notification] notifyRestaurantNewReservation: skipped — no recipients', {
      organizationId,
      restaurantId,
      source,
    });
    await recordOutcome({
      sent: false,
      recipients: [],
      skipReason: TEAM_NOTIFY_SKIP.NO_RECIPIENTS,
    });
    return false;
  }

  const dateYmd = formatInTimezone(dateTime, timezone, 'yyyy-MM-dd');
  const panelUrl = reservationsListUrl({ date: dateYmd });

  const sent = await sendNewReservationAlertEmail({
    emails,
    restaurantName,
    customerName,
    customerPhone,
    customerEmail,
    dateTime,
    partySize,
    panelUrl,
    timezone,
    source,
    organizationId,
    restaurantId,
    audience: 'restaurant',
  });

  if (sent) {
    await recordOutcome({ sent: true, recipients: emails, skipReason: null });
  } else {
    await recordOutcome({
      sent: false,
      recipients: emails,
      skipReason: TEAM_NOTIFY_SKIP.SEND_FAILED,
    });
  }

  return sent;
}

async function sendDailySummary(options) {
  const {
    email,
    restaurantName,
    count,
    firstTime,
    dateDisplay,
    panelUrl,
    reservations = [],
  } = options;
  if (!email) return false;

  const {
    buildDailySummaryHtml,
    buildDailySummarySubject,
  } = require('../templates/dailySummaryEmail');
  const { sendEmail } = require('./emailService');

  const subject = buildDailySummarySubject(count, restaurantName);
  const html = buildDailySummaryHtml({
    restaurantName,
    count,
    dateDisplay: dateDisplay || '',
    firstTime,
    panelUrl,
    reservations,
    assetBaseUrl: getEmailAssetBaseUrl(),
  });

  try {
    await sendEmail({
      fromEmail: await resolveTransactionalFromEmail(),
      toEmails: [email],
      subject,
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Daily summary email error:', err.message);
    return false;
  }
}

/**
 * Send payment failure notification to restaurant owner.
 * @param {Object} options
 * @param {string[]} options.emails - Owner emails
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.panelUrl - Link to billing page
 */
async function sendPaymentFailureNotification(options) {
  const { emails, restaurantName, panelUrl } = options;
  if (!emails || emails.length === 0) return false;

  const {
    buildPaymentFailureNotificationHtml,
    buildPaymentFailureSubject,
  } = require('../templates/paymentFailureNotificationEmail');
  const { sendEmail } = require('./emailService');

  const subject = buildPaymentFailureSubject(restaurantName);
  const html = buildPaymentFailureNotificationHtml({
    restaurantName,
    panelUrl,
    assetBaseUrl: getEmailAssetBaseUrl(),
  });

  try {
    await sendEmail({
      fromEmail: await resolveTransactionalFromEmail(),
      toEmails: emails,
      subject,
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Payment failure email error:', err.message);
    return false;
  }
}

/**
 * Send reservation confirmation email to the customer.
 * @param {Object} options
 * @param {string} options.customerEmail - Customer email
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.customerName - Customer name
 * @param {Date|string} options.dateTime - Reservation date/time
 * @param {number} options.partySize - Party size
 * @param {string} options.secureToken - Self-service token
 * @param {string|null} [options.timezone] - IANA timezone for formatting date/time in the email body
 * @returns {Promise<boolean>}
 */
async function sendReservationConfirmationEmail(options) {
  const { customerEmail, restaurantName, customerName, dateTime, partySize, secureToken, timezone } = options;
  if (!customerEmail) {
    console.log('[Notification] sendReservationConfirmationEmail: skipped — no customerEmail');
    return false;
  }

  console.log('[Notification] sendReservationConfirmationEmail: start', {
    to: customerEmail,
    restaurantName,
    customerName,
  });

  const { buildReservationConfirmationHtml } = require('../templates/reservationConfirmationEmail');
  const { sendEmail } = require('./emailService');

  const fromEmail = await resolveTransactionalFromEmail();

  console.log('[Notification] sendReservationConfirmationEmail: resolved sender', {
    fromEmail,
  });

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const viewUrl = `${baseUrl}/reservation/${secureToken}`;

  const html = buildReservationConfirmationHtml({
    restaurantName,
    customerName,
    dateTime,
    partySize,
    viewUrl,
    timezone: timezone || null,
    assetBaseUrl: baseUrl,
  });

  try {
    const result = await sendEmail({
      fromEmail,
      toEmails: [customerEmail],
      subject: `Confirmación de reserva: ${restaurantName}`,
      content: html,
      isHtml: true,
    });
    console.log('[Notification] sendReservationConfirmationEmail: sent OK', {
      to: customerEmail,
      resendId: result?.data?.id || result?.id || '(no id)',
    });
    return true;
  } catch (err) {
    console.error('[Notification] sendReservationConfirmationEmail: FAILED', {
      to: customerEmail,
      fromEmail,
      message: err.message,
      statusCode: err?.statusCode,
    });
    return false;
  }
}

/**
 * Send cancellation notification to restaurant owner/admin.
 * @param {Object} options
 */
async function sendCancellationNotification(options) {
  const {
    emails,
    restaurantName,
    customerName,
    customerPhone,
    dateTime,
    partySize,
    panelUrl,
    timezone = null,
  } = options;
  if (!emails || emails.length === 0) return false;

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt, timezone || undefined);
  const timeStr = formatTime(dt, timezone || undefined);

  const {
    buildCancellationNotificationHtml,
    buildCancellationSubject,
  } = require('../templates/cancellationNotificationEmail');
  const { sendEmail } = require('./emailService');

  const subject = buildCancellationSubject(customerName, restaurantName);
  const html = buildCancellationNotificationHtml({
    restaurantName,
    customerName,
    customerPhone,
    dateStr,
    timeStr,
    partySize,
    panelUrl,
    assetBaseUrl: getEmailAssetBaseUrl(),
  });

  try {
    await sendEmail({
      fromEmail: await resolveTransactionalFromEmail(),
      toEmails: emails,
      subject,
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Cancellation email error:', err.message);
    return false;
  }
}

/**
 * Avisa al restaurante por WhatsApp (si TWILIO está configurado y hay teléfono válido).
 */
async function notifyRestaurantWaitlistEntry(restaurant, entry) {
  const phone = normalizePhone(restaurant.phone);
  if (!phone) {
    console.log('[Waitlist] Restaurant has no valid phone, skipping alert');
    return false;
  }
  const lines = [
    `Nueva solicitud de lista de espera — ${restaurant.name}`,
    `${entry.customerName} · ${entry.partySize} pax`,
    `Tel: ${entry.customerPhone}`,
  ];
  if (entry.preferredDate) lines.push(`Fecha buscada: ${entry.preferredDate}`);
  if (entry.customerEmail) lines.push(`Email: ${entry.customerEmail}`);
  if (entry.notes) lines.push(`Nota: ${entry.notes}`);
  return sendWhatsAppTwilio(phone, lines.join('\n'));
}

/**
 * Post-visit feedback survey email to customer.
 */
async function sendPostVisitFeedbackEmail(options) {
  const {
    customerEmail,
    customerName,
    restaurantName,
    dateTime,
    timezone,
    clickUrl,
    optOutUrl,
    subjectVariant = 'a',
  } = options;
  if (!customerEmail) return false;

  const { buildPostVisitFeedbackHtml, getSubject } = require('../templates/postVisitFeedbackEmail');
  const { sendEmail } = require('./emailService');
  const prisma = require('../lib/prisma');

  const config = await prisma.configuration.findFirst();
  const fromSenderId = config?.reservationEmailSenderId || config?.recoveryEmailSenderId;
  const fromSender = fromSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: fromSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  const assetBaseUrl = getBaseUrl().replace(/\/$/, '');
  const html = buildPostVisitFeedbackHtml({
    restaurantName,
    customerName,
    dateTime,
    clickUrl,
    optOutUrl,
    timezone,
    assetBaseUrl,
  });

  try {
    await sendEmail({
      fromEmail,
      toEmails: [customerEmail],
      subject: getSubject(restaurantName, subjectVariant),
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Post-visit feedback email error:', err.message);
    return false;
  }
}

/**
 * Recovery alert to restaurant manager.
 */
async function sendFeedbackRecoveryAlertEmail(options) {
  const {
    emails,
    restaurantName,
    customerName,
    overallScore,
    comment,
    severity,
    panelUrl,
    customerEmail,
    customerPhone,
    visitDateTime,
    partySize,
    timezone,
    categoryScores,
    recoveryContactRequested,
    recoveryContactEmail,
  } = options;
  if (!emails?.length) return false;

  const {
    buildFeedbackRecoveryAlertHtml,
    getRecoveryAlertSubject,
  } = require('../templates/feedbackRecoveryAlertEmail');
  const { sendEmail } = require('./emailService');
  const prisma = require('../lib/prisma');
  const config = await prisma.configuration.findFirst();
  const fromSender = config?.recoveryEmailSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';
  const assetBaseUrl = getBaseUrl().replace(/\/$/, '');

  const html = buildFeedbackRecoveryAlertHtml({
    restaurantName,
    customerName,
    overallScore,
    comment,
    severity,
    panelUrl,
    customerEmail,
    customerPhone,
    visitDateTime,
    partySize,
    timezone,
    categoryScores,
    recoveryContactRequested,
    recoveryContactEmail,
    assetBaseUrl,
  });

  const subject = getRecoveryAlertSubject({
    restaurantName,
    customerName,
    overallScore,
    severity,
  });

  try {
    await sendEmail({
      fromEmail,
      toEmails: emails,
      subject,
      content: html,
      isHtml: true,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Feedback recovery alert error:', err.message);
    return false;
  }
}

/**
 * Envía resumen de periodo a destinatarios de la organización (admin).
 * @param {Object} options
 * @param {object} options.summary
 * @param {Array<{ email: string, name: string }>} options.recipients
 * @param {string} [options.personalNote]
 */
async function sendOrganizationPeriodSummaryEmails(options) {
  const { summary, recipients, personalNote = '' } = options;
  if (!recipients?.length || !summary) {
    return { sent: 0, failed: 0, results: [] };
  }

  const { buildPeriodSummaryEmailPayload } = require('./organizationPeriodSummaryService');
  const { sendEmail } = require('./emailService');

  const fromEmail = await resolveTransactionalFromEmail();
  const organizationId = summary.organizationId;

  let sent = 0;
  let failed = 0;
  const results = [];
  let subject = '';

  for (const recipient of recipients) {
    const payload = buildPeriodSummaryEmailPayload({
      summary,
      recipientName: recipient.name,
      organizationId,
      personalNote,
    });
    subject = payload.subject;
    const html = payload.html;
    try {
      await sendEmail({
        fromEmail,
        toEmails: [recipient.email],
        subject,
        content: html,
        isHtml: true,
      });
      sent += 1;
      results.push({ email: recipient.email, ok: true });
    } catch (err) {
      failed += 1;
      results.push({ email: recipient.email, ok: false, error: err.message });
      console.error('[Notification] Period summary email error:', recipient.email, err.message);
    }
  }

  return { sent, failed, results };
}

module.exports = {
  sendReservationConfirmation,
  sendReservationReminder,
  sendModificationAlertToCustomer,
  sendOrganizationOwnerWelcomeEmail,
  sendOrganizationPeriodSummaryEmails,
  sendDailySummary,
  sendPaymentFailureNotification,
  sendReservationConfirmationEmail,
  sendCancellationNotification,
  notifyRestaurantWaitlistEntry,
  sendPostVisitFeedbackEmail,
  sendFeedbackRecoveryAlertEmail,
  resolveReservationNotifyEmails,
  sendNewReservationAlertEmail,
  notifyRestaurantNewReservation,
  resolveTransactionalFromEmail,
};
