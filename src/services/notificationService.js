/**
 * Reservation confirmations and reminders via SMS and WhatsApp (Twilio).
 * Optional: if TWILIO_* env vars are not set, no message is sent.
 * WhatsApp uses Twilio WhatsApp API (TWILIO_WHATSAPP_FROM for sender).
 */

const { formatTime, formatDateDisplay } = require('../utils/dateFormat');
const { getEffectiveTimezone } = require('../utils/timezone');

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
  return process.env.BOOKING_BASE_URL || process.env.USER_FRONT_URL || 'http://localhost:5173';
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

async function sendWhatsAppTwilio(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromWa = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !fromWa) {
    return false;
  }

  const toWa = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const from = fromWa.startsWith('whatsapp:') ? fromWa : `whatsapp:${fromWa}`;

  try {
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      body,
      from,
      to: toWa,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Twilio WhatsApp error:', err.message);
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
    if (config?.whatsappConfirmations) {
      waOk = await sendWhatsAppTwilio(to, body);
    }
  } else {
    waOk = await sendWhatsAppTwilio(to, body);
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
    if (config?.whatsappReminders) {
      waOk = await sendWhatsAppTwilio(to, body);
    }
  } else {
    waOk = await sendWhatsAppTwilio(to, body);
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

  let body;
  if (type === 'cancelled') {
    body = `SimpleReserva: Tu reserva en ${restaurantName} ha sido cancelada correctamente.`;
  } else if (type === 'modified' && dateTime && partySize) {
    const dt = new Date(dateTime);
    const dateStr = formatDateDisplay(dt, timezone);
    const timeStr = formatTime(dt, timezone);
    body = `SimpleReserva: Tu reserva en ${restaurantName} ha sido actualizada. Nueva fecha: ${dateStr} a las ${timeStr} para ${partySize} persona(s).`;
  } else {
    return false;
  }

  if (restaurantId) {
    const planService = require('./planService');
    const config = await planService.resolvePlanConfigForRestaurant(restaurantId, true);
    if (!config?.whatsappModificationAlerts) return false;
  }
  return sendWhatsAppTwilio(to, body);
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

module.exports = {
  sendReservationConfirmation,
  sendReservationReminder,
  sendModificationAlertToCustomer,
  sendDailySummary,
  sendPaymentFailureNotification,
};
