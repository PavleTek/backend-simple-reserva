/**
 * Logos y medios de pago desde la API oficial de Mercado Pago.
 * @see GET /v1/payment_methods — secure_thumbnail por método (doc MCP / referencia MP)
 */

const { getMercadoPagoAccessToken } = require('../lib/mercadopagoEnv');

/** Logo oficial usado en navegación MP (mlstatic, 200 OK). */
const MERCADOPAGO_BRAND_LOGO_URL =
  'https://http2.mlstatic.com/frontend-assets/mp-web-navigation/ui-navigation/6.7.0/mercadopago/logo__large.png';

const MERCADOPAGO_BRAND_LOGO_SMALL_URL =
  'https://http2.mlstatic.com/frontend-assets/mp-web-navigation/ui-navigation/6.7.0/mercadopago/logo__small.png';

/**
 * IDs para logos en UI (Chile). Orden de preferencia; la API devuelve thumbnails oficiales.
 * @see GET /v1/payment_methods — secure_thumbnail
 */
const CHECKOUT_PRO_LOGO_IDS = ['visa', 'debvisa', 'debmaster', 'amex', 'presto', 'master'];

let cachedMethods = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchPaymentMethodsFromApi() {
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
  }

  const res = await fetch('https://api.mercadopago.com/v1/payment_methods', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MP payment_methods ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * @returns {{ brand: object, methods: Array<{ id, name, paymentTypeId, logoUrl }> }}
 */
async function getPaymentMethodAssets() {
  const now = Date.now();
  if (!cachedMethods || now >= cacheExpiresAt) {
    cachedMethods = await fetchPaymentMethodsFromApi();
    cacheExpiresAt = now + CACHE_TTL_MS;
  }

  const list = Array.isArray(cachedMethods) ? cachedMethods : [];
  const byId = new Map(list.map((m) => [m.id, m]));

  const methods = CHECKOUT_PRO_LOGO_IDS.filter((id) => byId.has(id)).map((id) => {
    const m = byId.get(id);
    return {
      id: m.id,
      name: m.name,
      paymentTypeId: m.payment_type_id,
      logoUrl: m.secure_thumbnail || m.thumbnail || null,
    };
  });

  return {
    brand: {
      logoLargeUrl: MERCADOPAGO_BRAND_LOGO_URL,
      logoSmallUrl: MERCADOPAGO_BRAND_LOGO_SMALL_URL,
    },
    methods,
  };
}

module.exports = {
  MERCADOPAGO_BRAND_LOGO_URL,
  MERCADOPAGO_BRAND_LOGO_SMALL_URL,
  getPaymentMethodAssets,
};
