/**
 * MercadoPago webhooks for subscription and payment events.
 * Configure webhook URL in MercadoPago dashboard: https://www.mercadopago.cl/developers/panel/app
 * Set MP_WEBHOOK_SECRET in .env (from Webhooks > Configure) to validate signatures.
 */

const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prisma');
const { activateOrganizationSubscription, enterGracePeriod } = require('../services/mercadopagoService');
const { createReceiptFromMPPayment } = require('../services/paymentReceiptService');

const router = express.Router();

// GET para verificar que la URL del webhook es accesible (abre en navegador o curl)
router.get('/mercadopago', (req, res) => {
  console.log('[Webhook] GET request received - webhook URL is reachable');
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

router.post('/mercadopago', express.json({ 
  verify: (req, res, buf) => {
    // Log raw body before JSON parsing
    console.log('[Webhook] ===== MercadoPago webhook received =====');
    console.log('[Webhook] Method:', req.method);
    console.log('[Webhook] URL:', req.url);
    console.log('[Webhook] Headers:', {
      'content-type': req.headers['content-type'],
      'x-signature': req.headers['x-signature'] ? 'present' : 'missing',
      'x-request-id': req.headers['x-request-id'] ? 'present' : 'missing',
      'user-agent': req.headers['user-agent'],
    });
    console.log('[Webhook] Raw body (before parsing):', buf.toString('utf8'));
    console.log('[Webhook] =========================================');
  }
}), async (req, res, next) => {
  // Log parsed body
  console.log('[Webhook] Parsed body:', JSON.stringify(req.body, null, 2));

  res.status(200).send('OK');

  try {
    const { type, data } = req.body || {};
    const dataId = data?.id != null ? String(data.id) : null;

    console.log('[Webhook] MercadoPago parsed:', { type, dataId });

    if (!dataId) {
      console.warn('[Webhook] MercadoPago: missing data.id');
      return;
    }

    if (!validateMPSignature(req, dataId)) {
      console.warn('[Webhook] MercadoPago signature validation failed – revisa MP_WEBHOOK_SECRET');
      return;
    }

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('[Webhook] MercadoPago: MERCADOPAGO_ACCESS_TOKEN not set');
      return;
    }

    const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });

    if (type === 'subscription_preapproval') {
      const preapprovalId = dataId;
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
      const organizationId = parts[0];
      const plan = parts[1] || 'profesional';

      const status = mpSub?.status ?? mpSub?.Status ?? null;
      console.log('[Webhook] MercadoPago preapproval:', { status, external_reference: externalRef, organizationId, plan });

      // Activar cuando el pago está autorizado. MP puede enviar "authorized" o "approved".
      const isAuthorized = status === 'authorized' || status === 'approved';
      if (isAuthorized) {
        try {
          await activateOrganizationSubscription(organizationId, preapprovalId, plan);
          console.log('[Webhook] MercadoPago subscription activated:', organizationId, plan);

          // Mark CheckoutSession as completed
          await prisma.checkoutSession.updateMany({
            where: { 
              mercadopagoPreapprovalId: preapprovalId,
              organizationId,
            },
            data: { 
              status: 'completed',
              completedAt: new Date(),
            },
          });
        } catch (err) {
          console.error('[Webhook] activateOrganizationSubscription/CheckoutSession update failed:', err?.message ?? err);
        }
      } else if (status === 'payment_required') {
        // Pago fallido o método inválido → periodo de gracia para actualizar
        await enterGracePeriod(organizationId);
        console.log('[Webhook] MercadoPago payment_required → grace period:', organizationId);
      } else if (status === 'cancelled' || status === 'expired') {
        await enterGracePeriod(organizationId);
      } else {
        console.log('[Webhook] MercadoPago status ignorado (no authorized/approved):', status);
      }
    } else if (type === 'payment') {
      const paymentId = dataId;
      const payment = new Payment(client);
      let mpPayment;
      try {
        mpPayment = await payment.get({ id: paymentId });
      } catch (err) {
        console.error('[Webhook] MercadoPago get payment failed:', err?.message ?? err);
        return;
      }

      const externalRef = mpPayment?.external_reference;
      if (!externalRef) {
        console.warn('[Webhook] MercadoPago: payment has no external_reference');
        return;
      }

      const parts = String(externalRef).split('|');
      const organizationId = parts[0];
      const planSKU = parts[1] || 'profesional';

      console.log('[Webhook] MercadoPago payment:', { 
        id: paymentId, 
        status: mpPayment.status, 
        amount: mpPayment.transaction_amount,
        organizationId,
        planSKU
      });

      if (mpPayment.status === 'approved') {
        try {
          await createReceiptFromMPPayment(mpPayment, organizationId, planSKU);
          console.log('[Webhook] MercadoPago receipt created for payment:', paymentId);
        } catch (err) {
          console.error('[Webhook] createReceiptFromMPPayment failed:', err?.message ?? err);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] MercadoPago error:', err?.message ?? err);
    console.error('[Webhook] Error stack:', err?.stack);
  }
}, (err, req, res, next) => {
  // Error handler for JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[Webhook] JSON parsing error:', err.message);
    console.error('[Webhook] This usually means MercadoPago sent invalid JSON or wrong content-type');
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

module.exports = router;
