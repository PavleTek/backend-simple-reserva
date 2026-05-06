'use strict';

const CONTACT_EMAIL =
  (process.env.CONTACT_EMAIL || '').trim() || 'contacto@simplereserva.com';

const WHATSAPP_DIGITS =
  ((process.env.WHATSAPP_DIGITS || process.env.VITE_WHATSAPP || '').replace(/\D/g, '') || '56951020295');

const WHATSAPP_DISPLAY =
  (process.env.WHATSAPP_DISPLAY || '').trim() || '+56 9 5102 0295';

const WHATSAPP_HREF = `https://wa.me/${WHATSAPP_DIGITS}`;

module.exports = { CONTACT_EMAIL, WHATSAPP_DIGITS, WHATSAPP_DISPLAY, WHATSAPP_HREF };
