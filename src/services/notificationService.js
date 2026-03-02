/**
 * Reservation confirmation via SMS (Twilio).
 * Optional: if TWILIO_* env vars are not set, no message is sent.
 * WhatsApp can be added later via Twilio WhatsApp API.
 */

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('56') && cleaned.length >= 9) {
    return `+${cleaned}`;
  }
  if (cleaned.length === 9 && cleaned.startsWith('9')) {
    return `+56${cleaned}`;
  }
  if (cleaned.length === 8) {
    return `+569${cleaned}`;
  }
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

/**
 * Send reservation confirmation SMS to the customer.
 * @param {Object} options
 * @param {string} options.customerPhone - Customer phone (Chilean format)
 * @param {string} options.restaurantName - Restaurant name
 * @param {Date|string} options.dateTime - Reservation date/time
 * @param {number} options.partySize - Party size
 * @param {string} options.secureToken - Self-service token
 * @returns {Promise<boolean>} - true if sent, false otherwise
 */
async function sendReservationConfirmation(options) {
  const {
    customerPhone,
    restaurantName,
    dateTime,
    partySize,
    secureToken,
  } = options;

  const to = normalizePhone(customerPhone);
  if (!to) {
    console.warn('[Notification] Invalid phone for SMS:', customerPhone);
    return false;
  }

  const dt = new Date(dateTime);
  const dateStr = dt.toLocaleDateString('es-CL', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timeStr = dt.toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const link = `${baseUrl}/reservation/${secureToken}`;

  const body = [
    `SimpleReserva: Tu reserva en ${restaurantName} está confirmada.`,
    `${dateStr} a las ${timeStr} para ${partySize} persona(s).`,
    `Ver o cancelar: ${link}`,
  ].join('\n');

  return sendSmsTwilio(to, body);
}

/**
 * Send day-before reminder SMS.
 */
async function sendReservationReminder(options) {
  const {
    customerPhone,
    restaurantName,
    dateTime,
    partySize,
    secureToken,
  } = options;

  const to = normalizePhone(customerPhone);
  if (!to) return false;

  const dt = new Date(dateTime);
  const timeStr = dt.toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const link = `${baseUrl}/reservation/${secureToken}`;

  const body = [
    `Recordatorio: Tienes reserva mañana en ${restaurantName} a las ${timeStr} para ${partySize} persona(s).`,
    `Confirmar o cancelar: ${link}`,
  ].join('\n');

  return sendSmsTwilio(to, body);
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
  const dateStr = dt.toLocaleDateString('es-CL', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timeStr = dt.toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  });

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

module.exports = {
  sendReservationConfirmation,
  sendReservationReminder,
  sendDailySummary,
  sendCancellationNotification,
  normalizePhone,
};
