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

function getBaseUrl() {
  return process.env.FRONTEND_LADNING_PAGE_URL || 'http://localhost:5174';
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
 * Email de bienvenida tras registro de restaurante (owner).
 */
async function sendWelcomeEmail({ email, restaurantName, panelUrl }) {
  if (!email) return false;

  const subject = `Bienvenido a SimpleReserva — ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `Tu cuenta para ${restaurantName} ya está lista.`,
    ``,
    `Entra al panel: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join("\n");

  const { sendEmail } = require("./emailService");
  const prisma = require("../lib/prisma");
  const config = await prisma.configuration.findFirst();
  const fromSender = config?.recoveryEmailSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
    : null;
  const fromEmail = fromSender || "noreply@simplereserva.com";

  try {
    await sendEmail({
      fromEmail,
      toEmails: [email],
      subject,
      content: body,
      isHtml: false,
    });
    return true;
  } catch (err) {
    console.error("[Notification] Welcome email error:", err.message);
    return false;
  }
}

async function sendDailySummary(options) {
  const { email, restaurantName, count, firstTime, panelUrl } = options;
  if (!email) return false;

  const subject = `SimpleReserva: ${count} reserva(s) hoy en ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `Hoy tienes ${count} reserva(s) en ${restaurantName}.`,
    firstTime ? `La primera es a las ${firstTime}.` : '',
    ``,
    `Ver todas: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join('\n');

  const { sendEmail } = require('./emailService');
  const prisma = require('../lib/prisma');
  const config = await prisma.configuration.findFirst();
  const fromSender = config?.recoveryEmailSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  try {
    await sendEmail({
      fromEmail,
      toEmails: [email],
      subject,
      content: body,
      isHtml: false,
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

  const subject = `Problema con el pago de tu suscripción en ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `No pudimos procesar el pago de tu suscripción para ${restaurantName}.`,
    `Tu cuenta ha entrado en un periodo de gracia de 7 días.`,
    `Por favor, actualiza tu método de pago para evitar la interrupción del servicio.`,
    ``,
    `Actualizar pago: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join('\n');

  const { sendEmail } = require('./emailService');
  const prisma = require('../lib/prisma');
  const config = await prisma.configuration.findFirst();
  const fromSender = config?.recoveryEmailSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  try {
    await sendEmail({
      fromEmail,
      toEmails: emails,
      subject,
      content: body,
      isHtml: false,
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
 * @returns {Promise<boolean>}
 */
async function sendReservationConfirmationEmail(options) {
  const { customerEmail, restaurantName, customerName, dateTime, partySize, secureToken } = options;
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
  const prisma = require('../lib/prisma');

  const config = await prisma.configuration.findFirst();
  const fromSenderId = config?.reservationEmailSenderId || config?.recoveryEmailSenderId;
  const fromSender = fromSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: fromSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  console.log('[Notification] sendReservationConfirmationEmail: resolved sender', {
    fromEmail,
    fromSenderId: fromSenderId || '(none — will fall back to noreply)',
    note: 'If fromEmail is not registered in emailSender table, send will fail',
  });

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const viewUrl = `${baseUrl}/reservation/${secureToken}`;

  const html = buildReservationConfirmationHtml({
    restaurantName,
    customerName,
    dateTime,
    partySize,
    viewUrl,
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
  const { emails, restaurantName, customerName, customerPhone, dateTime, partySize, panelUrl } = options;
  if (!emails || emails.length === 0) return false;

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt);
  const timeStr = formatTime(dt);

  const subject = `Reserva Cancelada: ${customerName} en ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `La siguiente reserva ha sido cancelada por el cliente:`,
    ``,
    `Restaurante: ${restaurantName}`,
    `Cliente: ${customerName}`,
    `Teléfono: ${customerPhone}`,
    `Fecha: ${dateStr}`,
    `Hora: ${timeStr}`,
    `Comensales: ${partySize}`,
    ``,
    `Puedes ver los detalles en tu panel: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join('\n');

  const { sendEmail } = require('./emailService');
  const prisma = require('../lib/prisma');
  const config = await prisma.configuration.findFirst();
  const fromSender = config?.recoveryEmailSenderId
    ? (await prisma.emailSender.findUnique({ where: { id: config.recoveryEmailSenderId } }))?.email
    : null;
  const fromEmail = fromSender || 'noreply@simplereserva.com';

  try {
    await sendEmail({
      fromEmail,
      toEmails: emails,
      subject,
      content: body,
      isHtml: false,
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

module.exports = {
  sendReservationConfirmation,
  sendReservationReminder,
  sendModificationAlertToCustomer,
  sendWelcomeEmail,
  sendDailySummary,
  sendPaymentFailureNotification,
  sendReservationConfirmationEmail,
  sendCancellationNotification,
  notifyRestaurantWaitlistEntry,
};
