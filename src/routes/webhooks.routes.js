/**
 * MercadoPago webhooks for subscription events.
 * Configure webhook URL in MercadoPago dashboard: https://www.mercadopago.cl/developers/panel/app
 * Set MP_WEBHOOK_SECRET in .env (from Webhooks > Configure) to validate signatures.
 */

const crypto = require('crypto');
const express = require('express');
const { activateRestaurantSubscription, enterGracePeriod } = require('../services/mercadopagoService');

const router = express.Router();

function validateMPSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
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
  const manifest = `id:${dataId};request-id:${xReqId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return expected === hash;
}

router.post('/mercadopago', express.json(), async (req, res) => {
  res.status(200).send('OK');

  try {
    const { type, data } = req.body || {};
    const dataId = data?.id != null ? String(data.id) : null;
    if (!dataId) return;

    if (!validateMPSignature(req, dataId)) {
      console.warn('[Webhook] MercadoPago signature validation failed');
      return;
    }

    const preapprovalId = dataId;

    if (type === 'subscription_preapproval') {
      const { MercadoPagoConfig, PreApproval } = require('mercadopago');
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) return;

      const client = new MercadoPagoConfig({ accessToken });
      const preApproval = new PreApproval(client);
      const mpSub = await preApproval.get({ id: preapprovalId });

      const externalRef = mpSub?.external_reference;
      if (!externalRef) return;

      const parts = String(externalRef).split('|');
      const restaurantId = parts[0];
      const plan = parts[1] || 'profesional';

      const status = mpSub?.status;

      if (status === 'authorized' || status === 'pending') {
        await activateRestaurantSubscription(restaurantId, preapprovalId, plan);
      } else if (status === 'cancelled' || status === 'expired') {
        await enterGracePeriod(restaurantId);
      }
    }
  } catch (err) {
    console.error('[Webhook] MercadoPago error:', err);
  }
});

module.exports = router;
