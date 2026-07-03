'use strict';

// El SDK de mercadopago (node-fetch) solo reintenta internamente errores con
// status >= 500. Errores de red a nivel de stream (conexion cerrada antes de
// terminar de leer el body) no traen status y se observaron repetidamente en
// produccion contra las llamadas GET /preapproval y GET /payments:
//   "Invalid response body while trying to fetch <url>: Premature close"
// Esto dejaba sin verificar suscripciones activas en cada corrida de
// reconciliacion. Este helper agrega reintentos con backoff para ese tipo de
// error transitorio especificamente.
const TRANSIENT_ERROR_PATTERN = /premature close|invalid response body|network|econnreset|socket hang up|etimedout/i;

function isTransientNetworkError(err) {
  return TRANSIENT_ERROR_PATTERN.test(err?.message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMpRetry(fn, { attempts = 5, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || i === attempts - 1) {
        throw err;
      }
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { withMpRetry, isTransientNetworkError };
