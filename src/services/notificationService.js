/**
 * Reservation confirmations and reminders via SMS and WhatsApp (Twilio).
 * Optional: if TWILIO_* env vars are not set, no message is sent.
 * WhatsApp uses Twilio WhatsApp API (TWILIO_WHATSAPP_FROM for sender).
 */

const { formatTime, formatDateDisplay } = require('../utils/dateFormat');

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

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt);
  const timeStr = formatTime(dt);

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

  const dt = new Date(dateTime);
  const timeStr = formatTime(dt);

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

  let body;
  if (type === 'cancelled') {
    body = `SimpleReserva: Tu reserva en ${restaurantName} ha sido cancelada correctamente.`;
  } else if (type === 'modified' && dateTime && partySize) {
    const dt = new Date(dateTime);
    const dateStr = formatDateDisplay(dt);
    const timeStr = formatTime(dt);
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
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const prisma = require('../lib/prisma');
    const sender = await prisma.emailSender.findFirst();
    const fromEmail = process.env.DAILY_SUMMARY_FROM || sender?.email;
    if (!fromEmail) {
      console.warn('[Notification] No from email for daily summary');
      return false;
    }
    const { sendViaResend } = require('./emailService');
    await sendViaResend({
      fromEmail,
      toEmails: [email],
      subject,
      content: body,
      isHtml: false,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Daily summary email failed:', err.message);
    return false;
  }
}

/**
 * Notify restaurant when a diner cancels a reservation.
 * Sends email to all owner/admin users of the restaurant.
 * @param {Object} options
 * @param {string[]} options.emails - Owner/admin emails to notify
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.customerName - Customer name
 * @param {string} options.customerPhone - Customer phone
 * @param {Date|string} options.dateTime - Original reservation date/time
 * @param {number} options.partySize - Party size
 * @param {string} options.panelUrl - Link to reservations panel
 */
async function sendCancellationNotification(options) {
  const { emails, restaurantName, customerName, customerPhone, dateTime, partySize, panelUrl } = options;
  if (!emails || emails.length === 0) return false;

  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt);
  const timeStr = formatTime(dt);

  const subject = `SimpleReserva: Reserva cancelada - ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `${customerName} (${customerPhone}) canceló su reserva en ${restaurantName}.`,
    ``,
    `Fecha/hora: ${dateStr} a las ${timeStr}`,
    `Comensales: ${partySize}`,
    ``,
    `Ver reservas: ${panelUrl}`,
  ].join('\n');

  try {
    const prisma = require('../lib/prisma');
    const sender = await prisma.emailSender.findFirst();
    const fromEmail = process.env.DAILY_SUMMARY_FROM || sender?.email;
    if (!fromEmail) {
      console.warn('[Notification] No from email for cancellation notification');
      return false;
    }
    const { sendViaResend } = require('./emailService');
    let sent = 0;
    for (const to of emails) {
      if (!to) continue;
      await sendViaResend({
        fromEmail,
        toEmails: [to],
        subject,
        content: body,
        isHtml: false,
      });
      sent++;
    }
    return sent > 0;
  } catch (err) {
    console.error('[Notification] Cancellation notification failed:', err.message);
    return false;
  }
}

/**
 * Send welcome email after restaurant registration.
 * @param {Object} options
 * @param {string} options.email - Owner email
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.panelUrl - Link to dashboard
 */
async function sendWelcomeEmail(options) {
  const { email, restaurantName, panelUrl } = options;
  if (!email) return false;

  const subject = `Bienvenido a SimpleReserva - ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `Bienvenido a SimpleReserva. Tu cuenta para ${restaurantName} está lista.`,
    ``,
    `Primeros pasos:`,
    `1. Agrega zonas y mesas en tu panel`,
    `2. Configura tus horarios de atención`,
    `3. Comparte el enlace de reservas con tus clientes`,
    ``,
    `Acceder a tu panel: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join('\n');

  try {
    const prisma = require('../lib/prisma');
    const sender = await prisma.emailSender.findFirst();
    const fromEmail = process.env.DAILY_SUMMARY_FROM || sender?.email;
    if (!fromEmail) {
      console.warn('[Notification] No from email for welcome email');
      return false;
    }
    const { sendViaResend } = require('./emailService');
    await sendViaResend({
      fromEmail,
      toEmails: [email],
      subject,
      content: body,
      isHtml: false,
    });
    return true;
  } catch (err) {
    console.error('[Notification] Welcome email failed:', err.message);
    return false;
  }
}

/**
 * Notify restaurant owner(s) when payment fails (grace period started).
 * @param {Object} options
 * @param {string[]} options.emails - Owner emails to notify
 * @param {string} options.restaurantName - Restaurant name
 * @param {string} options.panelUrl - Link to billing page
 */
async function sendPaymentFailureNotification(options) {
  const { emails, restaurantName, panelUrl } = options;
  if (!emails || emails.length === 0) return false;

  const subject = `SimpleReserva: Problema con tu pago - ${restaurantName}`;
  const body = [
    `Hola,`,
    ``,
    `Tu pago para ${restaurantName} no se pudo procesar. Tienes 7 días para actualizar tu método de pago y mantener el acceso a SimpleReserva.`,
    ``,
    `Ir a Facturación: ${panelUrl}`,
    ``,
    `Saludos,`,
    `El equipo de SimpleReserva`,
  ].join('\n');

  try {
    const prisma = require('../lib/prisma');
    const sender = await prisma.emailSender.findFirst();
    const fromEmail = process.env.DAILY_SUMMARY_FROM || sender?.email;
    if (!fromEmail) {
      console.warn('[Notification] No from email for payment failure notification');
      return false;
    }
    const { sendViaResend } = require('./emailService');
    let sent = 0;
    for (const to of emails) {
      if (!to) continue;
      await sendViaResend({
        fromEmail,
        toEmails: [to],
        subject,
        content: body,
        isHtml: false,
      });
      sent++;
    }
    return sent > 0;
  } catch (err) {
    console.error('[Notification] Payment failure notification failed:', err.message);
    return false;
  }
}

module.exports = {
  sendReservationConfirmation,
  sendReservationReminder,
  sendModificationAlertToCustomer,
  sendDailySummary,
  sendCancellationNotification,
  sendWelcomeEmail,
  sendPaymentFailureNotification,
  normalizePhone,
};
