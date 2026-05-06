'use strict';

/**
 * Resuelve credenciales de Mercado Pago según entorno de despliegue.
 *
 * Regla por defecto:
 * - NODE_ENV === 'production' → par *_PRODUCTION (si existe) o variables genéricas.
 * - En otro caso → par *_DEVELOPMENT o genéricas.
 *
 * Sobrescritura explícita: MERCADOPAGO_ENV=development | production
 * (útil si NODE_ENV es production pero quieres apuntar a cuentas de prueba MP).
 */

function trimmed(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @returns {boolean}
 */
function mercadoPagoUseProductionCredentials() {
  const flag = trimmed('MERCADOPAGO_ENV').toLowerCase();
  if (flag === 'production') return true;
  if (flag === 'development') return false;
  return process.env.NODE_ENV === 'production';
}

function pickCred(devKey, prodKey, fallbackKey) {
  const prod = mercadoPagoUseProductionCredentials();
  const legacy = trimmed(fallbackKey);
  const devOnly = trimmed(devKey);
  const prodOnly = trimmed(prodKey);
  if (prod) {
    return prodOnly || legacy;
  }
  return devOnly || legacy;
}

function getMercadoPagoAccessToken() {
  return pickCred(
    'MERCADOPAGO_ACCESS_TOKEN_DEVELOPMENT',
    'MERCADOPAGO_ACCESS_TOKEN_PRODUCTION',
    'MERCADOPAGO_ACCESS_TOKEN',
  );
}

function getMercadoPagoPublicKey() {
  return pickCred('MP_PUBLIC_KEY_DEVELOPMENT', 'MP_PUBLIC_KEY_PRODUCTION', 'MP_PUBLIC_KEY');
}

/** Secret HMAC para validar POST del webhook (puede diferir entre app test y producción). */
function getMercadoPagoWebhookSecret() {
  return pickCred(
    'MP_WEBHOOK_SECRET_DEVELOPMENT',
    'MP_WEBHOOK_SECRET_PRODUCTION',
    'MP_WEBHOOK_SECRET',
  );
}

function describeMercadoPagoCredentialChoice() {
  const prod = mercadoPagoUseProductionCredentials();
  const override = trimmed('MERCADOPAGO_ENV');
  let source = prod ? 'production' : 'development';
  if (override) {
    source += ` (MERCADOPAGO_ENV=${override})`;
  } else if (process.env.NODE_ENV === 'production' && prod) {
    source += ' (NODE_ENV=production)';
  }
  const at = getMercadoPagoAccessToken();
  const pk = getMercadoPagoPublicKey();
  let whichAt = '(ninguno)';
  if (at) {
    if (prod && trimmed('MERCADOPAGO_ACCESS_TOKEN_PRODUCTION')) whichAt = 'MERCADOPAGO_ACCESS_TOKEN_PRODUCTION';
    else if (!prod && trimmed('MERCADOPAGO_ACCESS_TOKEN_DEVELOPMENT'))
      whichAt = 'MERCADOPAGO_ACCESS_TOKEN_DEVELOPMENT';
    else if (trimmed('MERCADOPAGO_ACCESS_TOKEN')) whichAt = 'MERCADOPAGO_ACCESS_TOKEN';
    else whichAt = '(resuelto)';
  }
  let whichPk = '(ninguno)';
  if (pk) {
    if (prod && trimmed('MP_PUBLIC_KEY_PRODUCTION')) whichPk = 'MP_PUBLIC_KEY_PRODUCTION';
    else if (!prod && trimmed('MP_PUBLIC_KEY_DEVELOPMENT')) whichPk = 'MP_PUBLIC_KEY_DEVELOPMENT';
    else if (trimmed('MP_PUBLIC_KEY')) whichPk = 'MP_PUBLIC_KEY';
    else whichPk = '(resuelto)';
  }
  return { prod, source, accessTokenEnvKey: whichAt, publicKeyEnvKey: whichPk };
}

module.exports = {
  mercadoPagoUseProductionCredentials,
  getMercadoPagoAccessToken,
  getMercadoPagoPublicKey,
  getMercadoPagoWebhookSecret,
  describeMercadoPagoCredentialChoice,
};
