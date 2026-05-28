/**
 * MercadoPago webhooks for subscription and payment events.
 * Configure webhook URL in MercadoPago dashboard: https://www.mercadopago.cl/developers/panel/app
 * Firma HMAC: define MP_WEBHOOK_SECRET_* o MP_WEBHOOK_SECRET (según mercadopagoEnv).
 *
 * Hardening:
 * - Firma HMAC validada antes de 200 OK (no se persisten eventos con firma inválida).
 * - Cada evento se persiste en WebhookEvent (idempotencia por DB, debugging retroactivo).
 * - Tras 200 OK el procesamiento sigue en la misma request (MP evita timeout si respondes rápido).
 */

const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prisma');
const { getMercadoPagoAccessToken, getMercadoPagoWebhookSecret } = require('../lib/mercadopagoEnv');
const {
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  cancelReplacedPreapprovalOnSchedule,
  enterGracePeriod,
  getActivateOptionsForPreapproval,
} = require('../services/mercadopagoService');
const { createReceiptFromMPPayment } = require('../services/paymentReceiptService');
const { computePeriodEnd } = require('../lib/billingPeriod');

const router = express.Router();

// GET para verificar que la URL del webhook es accesible (abre en navegador o curl)
router.get('/mercadopago', (req, res) => {
  console.log('[Webhook] GET request received - webhook URL is reachable');
  res.json({ ok: true, message: 'Webhook URL reachable. POST from MercadoPago will process events.' });
});

function validateMPSignature(req, dataId) {
  const secret = getMercadoPagoWebhookSecret();
  if (!secret || secret === '') {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Webhook] CRITICAL: secret de webhook MP no configurado en producción. Rechazando webhook.');
      return false;
    }
    return true; // Solo permitir sin secret en desarrollo/staging
  }
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
  const expBuf = Buffer.from(String(expected).trim(), 'hex');
  const gotBuf = Buffer.from(String(hash).trim(), 'hex');
  if (expBuf.length !== gotBuf.length || expBuf.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(expBuf, gotBuf);
}

router.post('/mercadopago', express.json({ 
  verify: (req, res, buf) => {
    if (process.env.NODE_ENV !== 'production') {
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
  }
}), async (req, res, next) => {
  console.log('[Webhook] MercadoPago received:', {
    type: req.body?.type,
    dataId: req.body?.data?.id,
    xRequestId: req.headers['x-request-id'] || null,
    hasSignature: !!req.headers['x-signature'],
  });

  const { type, data } = req.body || {};
  const dataId = data?.id != null ? String(data.id) : null;

  if (!dataId) {
    console.warn('[Webhook] MercadoPago: missing data.id');
    return res.status(400).send('Bad Request');
  }

  if (!validateMPSignature(req, dataId)) {
    console.warn('[Webhook] MercadoPago signature validation failed – revisa MP_WEBHOOK_SECRET_* / MP_WEBHOOK_SECRET');
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  try {
    // --- PERSISTIR EVENTO (idempotencia y audit log) ---
    // Intentar crear; si ya existe (unique violation), obtener el existente.
    let webhookEvent;
    try {
      webhookEvent = await prisma.webhookEvent.create({
        data: {
          mpEventType: type || 'unknown',
          mpDataId: dataId,
          rawHeaders: {
            xRequestId: req.headers['x-request-id'] || null,
            xSignature: req.headers['x-signature'] ? 'present' : 'missing',
            userAgent: req.headers['user-agent'] || null,
          },
        },
      });
    } catch (createErr) {
      // Unique violation: evento ya existe. Buscar el existente.
      webhookEvent = await prisma.webhookEvent.findUnique({
        where: { mpEventType_mpDataId: { mpEventType: type || 'unknown', mpDataId: dataId } },
      });
      if (!webhookEvent) {
        console.error('[Webhook] No se pudo crear ni encontrar WebhookEvent:', createErr?.message);
        return;
      }
    }

    // Si ya fue procesado exitosamente, saltar (idempotencia)
    if (webhookEvent.processingStatus === 'processed') {
      console.log('[Webhook] Evento ya procesado, ignorando:', type, dataId);
      return;
    }

    // Simulador del panel MP (Tus integraciones → Webhooks → Simular): data.id fijo, no existe en API.
    if (dataId === '123456') {
      console.log('[Webhook] MercadoPago: evento de simulación (data.id=123456), sin llamada a API');
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'skipped', errorMessage: 'MP webhook simulator (data.id=123456)' },
      });
      return;
    }

    const accessToken = getMercadoPagoAccessToken();
    if (!accessToken) {
      console.error('[Webhook] MercadoPago: MERCADOPAGO_ACCESS_TOKEN not set');
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'failed', errorMessage: 'MERCADOPAGO_ACCESS_TOKEN not set' },
      });
      return;
    }

    const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken });

    // --- PROCESAR EVENTO ---
    try {
      if (type === 'subscription_preapproval' || type === 'subscription_authorized_payment') {
        const preapprovalId = dataId;
        const preApproval = new PreApproval(client);
        let mpSub;
        try {
          mpSub = await preApproval.get({ id: preapprovalId });
        } catch (err) {
          console.error('[Webhook] MercadoPago get preapproval failed:', err?.message ?? err);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'failed', errorMessage: `get preapproval failed: ${err?.message?.slice(0, 400)}` },
          });
          return;
        }

        const externalRef = mpSub?.external_reference;
        if (!externalRef) {
          console.warn('[Webhook] MercadoPago: preapproval has no external_reference');
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'skipped', errorMessage: 'no external_reference' },
          });
          return;
        }

        const parts = String(externalRef).split('|');
        const organizationId = parts[0];
        const plan = parts[1] || 'plan-profesional';

        // Skip processing for soft-deleted organizations
        const orgCheck = await prisma.restaurantOrganization.findUnique({
          where: { id: organizationId },
          select: { isDeleted: true },
        });
        if (!orgCheck || orgCheck.isDeleted) {
          console.warn('[Webhook] MercadoPago: skipping event for deleted/unknown org:', organizationId);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'skipped', errorMessage: 'organization is deleted or not found', organizationId },
          });
          return;
        }

        const status = mpSub?.status ?? mpSub?.Status ?? null;
        console.log('[Webhook] MercadoPago preapproval (%s):', type, { status, external_reference: externalRef, organizationId, plan });

        const isAuthorized = status === 'authorized' || status === 'approved';
        if (isAuthorized) {
          const mpStartDate = mpSub?.auto_recurring?.start_date || mpSub?.start_date || mpSub?.date_created;
          const THRESHOLD_MS = 10 * 60 * 1000;
          const isFutureStart = mpStartDate && (new Date(mpStartDate).getTime() - Date.now() > THRESHOLD_MS);

          if (isFutureStart) {
            await scheduleOrganizationSubscription(organizationId, preapprovalId, plan, new Date(mpStartDate));
            await cancelReplacedPreapprovalOnSchedule(organizationId, preapprovalId);
            console.log('[Webhook] MercadoPago subscription scheduled (future start):', organizationId, plan, mpStartDate);
          } else {
            const activateOpts = await getActivateOptionsForPreapproval(organizationId, preapprovalId);
            await activateOrganizationSubscription(organizationId, preapprovalId, plan, activateOpts);
            console.log('[Webhook] MercadoPago subscription activated:', organizationId, plan);
          }

          await prisma.checkoutSession.updateMany({
            where: { mercadopagoPreapprovalId: preapprovalId, organizationId },
            data: { status: 'completed', completedAt: new Date() },
          });
        } else if (status === 'payment_required') {
          await enterGracePeriod(organizationId, { scheduledPreapprovalId: preapprovalId });
          console.log('[Webhook] MercadoPago payment_required → grace period:', organizationId);
        } else if (status === 'cancelled' || status === 'expired') {
          await enterGracePeriod(organizationId, { scheduledPreapprovalId: preapprovalId });
          console.log('[Webhook] MercadoPago', status, '→ grace period:', organizationId);
        } else {
          console.log('[Webhook] MercadoPago status ignorado:', status);
        }

        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            processingStatus: 'processed',
            mpStatus: status,
            organizationId,
            externalRef,
            processedAt: new Date(),
          },
        });

      } else if (type === 'payment') {
        const paymentId = dataId;
        const payment = new Payment(client);
        let mpPayment;
        try {
          mpPayment = await payment.get({ id: paymentId });
        } catch (err) {
          console.error('[Webhook] MercadoPago get payment failed:', err?.message ?? err);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'failed', errorMessage: `get payment failed: ${err?.message?.slice(0, 400)}` },
          });
          return;
        }

        const externalRef = mpPayment?.external_reference;
        if (!externalRef) {
          console.warn('[Webhook] MercadoPago: payment has no external_reference');
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'skipped', errorMessage: 'no external_reference' },
          });
          return;
        }

        const parts = String(externalRef).split('|');
        const organizationId = parts[0];
        const planSKU = parts[1] || 'plan-profesional';

        // Skip processing for soft-deleted organizations
        const orgCheckPayment = await prisma.restaurantOrganization.findUnique({
          where: { id: organizationId },
          select: { isDeleted: true },
        });
        if (!orgCheckPayment || orgCheckPayment.isDeleted) {
          console.warn('[Webhook] MercadoPago: skipping payment event for deleted/unknown org:', organizationId);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'skipped', errorMessage: 'organization is deleted or not found', organizationId },
          });
          return;
        }

        console.log('[Webhook] MercadoPago payment:', { 
          id: paymentId, 
          status: mpPayment.status, 
          amount: mpPayment.transaction_amount,
          organizationId,
          planSKU,
        });

        if (mpPayment.status === 'approved') {
          await createReceiptFromMPPayment(mpPayment, organizationId, planSKU);
          console.log('[Webhook] MercadoPago receipt created for payment:', paymentId);
          // Reactivar acceso si estaba en periodo de gracia por fallo de cobro
          const reactivated = await prisma.subscription.updateMany({
            where: { organizationId, status: 'grace' },
            data: { status: 'active', gracePeriodEndsAt: null },
          });
          if (reactivated.count > 0) {
            const planService = require('../services/planService');
            planService.invalidateCache(organizationId);
            console.log('[Webhook] MercadoPago payment approved → grace cleared, org:', organizationId);
            // Limpiar trialEndsAt para que la UI no muestre "Prueba gratuita" si el pago
            // se procesó mientras el periodo de prueba aún estaba vigente
            await prisma.restaurantOrganization.update({
              where: { id: organizationId },
              data: { trialEndsAt: null },
            }).catch((e) => console.warn('[Webhook] No se pudo limpiar trialEndsAt:', e?.message ?? e));
          }

          try {
            const activeSub = await prisma.subscription.findFirst({
              where: { organizationId, status: 'active' },
              include: { plan: true },
            });
            if (activeSub?.plan) {
              const nextPeriod = computePeriodEnd(activeSub.startDate, activeSub.plan);
              if (nextPeriod) {
                await prisma.subscription.update({
                  where: { id: activeSub.id },
                  data: { currentPeriodEnd: nextPeriod },
                });
              }
            }
          } catch (e) {
            console.warn('[Webhook] No se pudo actualizar currentPeriodEnd:', e?.message ?? e);
          }
        }

        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            processingStatus: 'processed',
            mpStatus: mpPayment.status,
            organizationId,
            externalRef,
            processedAt: new Date(),
          },
        });

      } else {
        // Tipo de evento no manejado: marcar como skipped
        console.log('[Webhook] MercadoPago: tipo de evento no manejado:', type);
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { processingStatus: 'skipped', errorMessage: `unhandled event type: ${type}` },
        });
      }
    } catch (processingErr) {
      console.error('[Webhook] Error procesando evento:', processingErr?.message ?? processingErr);
      console.error('[Webhook] Stack:', processingErr?.stack);
      // Marcar como failed para que el job de reconciliacion lo reintente
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          processingStatus: 'failed',
          errorMessage: processingErr?.message?.slice(0, 500) ?? 'unknown error',
        },
      }).catch(() => {}); // No fallar si no se puede actualizar
    }
  } catch (err) {
    console.error('[Webhook] MercadoPago unhandled error:', err?.message ?? err);
    console.error('[Webhook] Error stack:', err?.stack);
  }
}, (err, req, res, next) => {
  // Error handler para JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[Webhook] JSON parsing error:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

module.exports = router;
