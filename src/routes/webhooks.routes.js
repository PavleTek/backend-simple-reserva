/**
 * MercadoPago webhooks for subscription events.
 * Configure webhook URL in MercadoPago dashboard: https://www.mercadopago.cl/developers/panel/app
 * Set MP_WEBHOOK_SECRET in .env (from Webhooks > Configure) to validate signatures.
 */

const crypto = require('crypto');
const express = require('express');
const { activateRestaurantSubscription, enterGracePeriod } = require('../services/mercadopagoService');

const router = express.Router();

// GET para verificar que la URL del webhook es accesible (abre en navegador o curl)
router.get('/mercadopago', (req, res) => {
  res.json({ ok: true, message: 'Webhook URL reachable. POST from MercadoPago will process events.' });
});

function validateMPSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret || secret === '') return true; // Sin secret = no validar (útil para debug)
  const xSig = req.headers['x-signature'];
  const xReqId = req.headers['x-request-id'];
  if (!xSig || !xReqId) return false;
  const parts = xSig.split(',');
  let ts = '', hash = '';
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k?.trim() === 'ts') ts = v?.trim() ?? '';
    if (k?.trim() === 'v1') hash = v?.trim() ?? '';
  }
  // MP docs: alphanumeric ids must be lowercase in manifest
  const idForManifest = /^[a-zA-Z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const manifest = `id:${idForManifest};request-id:${xReqId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return expected === hash;
}

router.post('/mercadopago', express.json(), async (req, res) => {
  res.status(200).send('OK');

  try {
    const { type, data } = req.body || {};
    const dataId = data?.id != null ? String(data.id) : null;

    console.log('[Webhook] MercadoPago received:', { type, dataId });

    if (!dataId) {
      console.warn('[Webhook] MercadoPago: missing data.id');
      return;
    }

    if (!validateMPSignature(req, dataId)) {
      console.warn('[Webhook] MercadoPago signature validation failed – revisa MP_WEBHOOK_SECRET');
      return;
    }

    const preapprovalId = dataId;

    if (type === 'subscription_preapproval') {
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) {
        console.error('[Webhook] MercadoPago: MERCADOPAGO_ACCESS_TOKEN not set');
        return;
      }

      const { MercadoPagoConfig, PreApproval } = require('mercadopago');
      const client = new MercadoPagoConfig({ accessToken });
      const preApproval = new PreApproval(client);
      let mpSub;
      try {
        mpSub = await preApproval.get({ id: preapprovalId });
      } catch (err) {
        console.error('[Webhook] MercadoPago get preapproval failed:', err?.message ?? err);
        return;
      }

      const externalRef = mpSub?.external_reference;
      if (!externalRef) {
        console.warn('[Webhook] MercadoPago: preapproval has no external_reference');
        return;
      }

      const parts = String(externalRef).split('|');
      const restaurantId = parts[0];
      const plan = parts[1] || 'profesional';

      const status = mpSub?.status ?? mpSub?.Status ?? null;
      console.log('[Webhook] MercadoPago preapproval:', { status, external_reference: externalRef, restaurantId, plan });

      // Activar cuando el pago está autorizado. MP puede enviar "authorized" o "approved".
      const isAuthorized = status === 'authorized' || status === 'approved';
      if (isAuthorized) {
        try {
          await activateRestaurantSubscription(restaurantId, preapprovalId, plan);
          console.log('[Webhook] MercadoPago subscription activated:', restaurantId, plan);
        } catch (err) {
          console.error('[Webhook] activateRestaurantSubscription failed:', err?.message ?? err);
        }
      } else if (status === 'payment_required') {
        // Pago fallido o método inválido → periodo de gracia para actualizar
        await enterGracePeriod(restaurantId);
        console.log('[Webhook] MercadoPago payment_required → grace period:', restaurantId);
      } else if (status === 'cancelled' || status === 'expired') {
        await enterGracePeriod(restaurantId);
      } else {
        console.log('[Webhook] MercadoPago status ignorado (no authorized/approved):', status);
      }
    }
  } catch (err) {
    console.error('[Webhook] MercadoPago error:', err?.message ?? err);
  }
});

module.exports = router;
