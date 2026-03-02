/**
 * MercadoPago webhooks for subscription events.
 * Configure webhook URL in MercadoPago dashboard: https://api.mercadopago.com/webhooks
 * For local testing use ngrok or similar.
 */

const express = require('express');
const prisma = require('../lib/prisma');
const { activateRestaurantSubscription, deactivateRestaurantSubscription } = require('../services/mercadopagoService');

const router = express.Router();

router.post('/mercadopago', express.json(), async (req, res) => {
  res.status(200).send('OK');

  try {
    const { type, data } = req.body || {};
    if (!data?.id) return;

    const preapprovalId = String(data.id);

    if (type === 'subscription_preapproval') {
      const { MercadoPagoConfig, PreApproval } = require('mercadopago');
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) return;

      const client = new MercadoPagoConfig({ accessToken });
      const preApproval = new PreApproval(client);
      const mpSub = await preApproval.get({ id: preapprovalId });

      const restaurantId = mpSub?.external_reference;
      if (!restaurantId) return;

      const status = mpSub?.status;

      if (status === 'authorized' || status === 'pending') {
        await activateRestaurantSubscription(restaurantId, preapprovalId);
      } else if (status === 'cancelled' || status === 'expired') {
        await deactivateRestaurantSubscription(restaurantId);
      }
    }
  } catch (err) {
    console.error('[Webhook] MercadoPago error:', err);
  }
});

module.exports = router;
