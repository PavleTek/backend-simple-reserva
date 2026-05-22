'use strict';

const isDev = process.env.NODE_ENV === 'development';

/** Mínimo de sendDelayMinutes al guardar encuesta (1 en dev para pruebas, 15 en prod). */
const FEEDBACK_SEND_DELAY_MIN_MINUTES = isDev ? 1 : 15;

const FEEDBACK_SEND_DELAY_MAX_MINUTES = 480;

function validateSendDelayMinutes(value, options = {}) {
  if (value === undefined || value === null) return { ok: true };
  if (options.eligibilityMode === 'completed_only') return { ok: true };
  const min = options.admin ? 1 : FEEDBACK_SEND_DELAY_MIN_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: 'sendDelayMinutes debe ser un número entero' };
  }
  if (n < min || n > FEEDBACK_SEND_DELAY_MAX_MINUTES) {
    return {
      ok: false,
      message: `sendDelayMinutes debe estar entre ${min} y ${FEEDBACK_SEND_DELAY_MAX_MINUTES}`,
    };
  }
  return { ok: true, value: n };
}

module.exports = {
  FEEDBACK_SEND_DELAY_MIN_MINUTES,
  FEEDBACK_SEND_DELAY_MAX_MINUTES,
  validateSendDelayMinutes,
};
