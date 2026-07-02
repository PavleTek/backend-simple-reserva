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
const { getMercadoPagoAccessToken, getMercadoPagoWebhookSecrets } = require('../lib/mercadopagoEnv');
const {
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  cancelReplacedPreapprovalOnSchedule,
  enterGracePeriod,
  getActivateOptionsForPreapproval,
} = require('../services/mercadopagoService');
const { applyBillingEvent } = require('../services/billing/billingStateService');
const { shouldEnterGraceFromRejectedPayment } = require('../services/billing/paymentFailureDetection');
const { createReceiptFromMPPayment } = require('../services/paymentReceiptService');
const { computePeriodEnd } = require('../lib/billingPeriod');
const referralService = require('../services/referralService');
const { parseExternalReference } = require('../lib/billingProviders');
const { parseExternalReferenceV2 } = require('../lib/externalReferenceV2');
const { normalizeMercadoPagoWebhook } = require('../services/billing/webhooks/normalizer');
const { persistPaymentMethodSnapshot } = require('../services/billing/paymentMethodSnapshot');
const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');

const router = express.Router();

// GET para verificar que la URL del webhook es accesible (abre en navegador o curl)
router.get('/mercadopago', (req, res) => {
  console.log('[Webhook] GET request received - webhook URL is reachable');
  res.json({ ok: true, message: 'Webhook URL reachable. POST from MercadoPago will process events.' });
});

function validateMPSignature(req, dataId) {
  const secrets = getMercadoPagoWebhookSecrets();
  if (!secrets.length) {
    // Fail closed in all environments unless explicitly bypassed for local dev.
    // Set SKIP_WEBHOOK_SIGNATURE_CHECK=true to bypass in dev/staging.
    if (process.env.SKIP_WEBHOOK_SIGNATURE_CHECK === 'true') {
      console.warn('[Webhook] WARNING: signature validation skipped (SKIP_WEBHOOK_SIGNATURE_CHECK=true)');
      return true;
    }
    console.error('[Webhook] CRITICAL: secret de webhook MP no configurado. Rechazando webhook. Configura MP_WEBHOOK_SECRET_* o establece SKIP_WEBHOOK_SIGNATURE_CHECK=true en desarrollo.');
    return false;
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

  // Replay protection: reject if timestamp is more than 5 minutes old or in the future
  const tsNum = Number(ts);
  if (ts && !Number.isNaN(tsNum)) {
    const ageMs = Date.now() - tsNum * 1000;
    const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    if (ageMs > REPLAY_WINDOW_MS || ageMs < -30000) {
      console.warn('[Webhook] Signature timestamp replay window exceeded:', { ts, ageMs });
      return false;
    }
  }

  // Use req.query['data.id'] as primary dataId for HMAC manifest (MP spec)
  const manifestDataId = req.query?.['data.id'] ? String(req.query['data.id']) : dataId;
  const idForManifest = /^[a-zA-Z0-9]+$/.test(String(manifestDataId)) ? String(manifestDataId).toLowerCase() : String(manifestDataId);
  const manifest = `id:${idForManifest};request-id:${xReqId};ts:${ts};`;

  for (const secret of secrets) {
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const expBuf = Buffer.from(String(expected).trim(), 'hex');
    const gotBuf = Buffer.from(String(hash).trim(), 'hex');
    if (expBuf.length === gotBuf.length && expBuf.length > 0 && crypto.timingSafeEqual(expBuf, gotBuf)) {
      return true;
    }
  }
  return false;
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

    // Atomic claim: sólo un worker procesa cada evento. Incluye 'skipped' para que
    // notificaciones pending → approved (mismo data.id) puedan re-evaluarse.
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        id: webhookEvent.id,
        processingStatus: { in: ['received', 'failed', 'skipped'] },
      },
      data: { processingStatus: 'processing' },
    });
    if (claimed.count === 0) {
      console.log('[Webhook] Evento ya siendo procesado o completado, ignorando:', type, dataId);
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
        // For subscription_authorized_payment, data.id is the authorized-payment (invoice) id,
        // NOT the preapproval id. Resolve the actual preapproval id first.
        let preapprovalId = dataId;
        if (type === 'subscription_authorized_payment') {
          try {
            const apRes = await fetch(
              `https://api.mercadopago.com/v1/authorized_payments/${dataId}`,
              { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
            );
            const apData = await apRes.json();
            const resolvedPreapprovalId = apData?.preapproval_id;
            if (!resolvedPreapprovalId) {
              console.warn('[Webhook] subscription_authorized_payment: no preapproval_id en authorized_payment', dataId, apData);
              await prisma.webhookEvent.update({
                where: { id: webhookEvent.id },
                data: { processingStatus: 'skipped', errorMessage: 'no preapproval_id en authorized_payment' },
              });
              return;
            }
            preapprovalId = resolvedPreapprovalId;
          } catch (apErr) {
            console.error('[Webhook] subscription_authorized_payment: error fetching authorized_payment:', apErr?.message ?? apErr);
            await prisma.webhookEvent.update({
              where: { id: webhookEvent.id },
              data: { processingStatus: 'failed', errorMessage: `authorized_payment fetch failed: ${apErr?.message?.slice(0, 400)}` },
            });
            return;
          }
        }

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
            const referralFreeWindowService = require('../services/billing/referralFreeWindowService');
            const isReferralWindow = await referralFreeWindowService.isReferralFreeWindowPreapproval(
              organizationId,
              preapprovalId,
            );
            if (isReferralWindow) {
              const activateOpts = await getActivateOptionsForPreapproval(organizationId, preapprovalId);
              await activateOrganizationSubscription(organizationId, preapprovalId, plan, {
                ...activateOpts,
                referralFreeUntil: new Date(mpStartDate),
                skipMarkFirstPayment: true,
              });
              await cancelReplacedPreapprovalOnSchedule(organizationId, preapprovalId);
              console.log('[Webhook] MercadoPago referral free window activated:', organizationId, plan, mpStartDate);
            } else {
              await scheduleOrganizationSubscription(organizationId, preapprovalId, plan, new Date(mpStartDate));
              await cancelReplacedPreapprovalOnSchedule(organizationId, preapprovalId);
              console.log('[Webhook] MercadoPago subscription scheduled (future start):', organizationId, plan, mpStartDate);
            }
          } else {
            const activateOpts = await getActivateOptionsForPreapproval(organizationId, preapprovalId);
            await activateOrganizationSubscription(organizationId, preapprovalId, plan, activateOpts);
            console.log('[Webhook] MercadoPago subscription activated:', organizationId, plan);
            try {
              const activeSub = await prisma.subscription.findFirst({
                where: { organizationId, mercadopagoPreapprovalId: preapprovalId, status: 'active' },
                select: { referralFreeUntil: true },
              });
              if (!activeSub?.referralFreeUntil) {
                await referralService.markFirstPayment(organizationId);
              }
            } catch (refErr) {
              console.warn('[Webhook] markFirstPayment failed:', refErr?.message ?? refErr);
            }
          }

          await prisma.checkoutSession.updateMany({
            where: { mercadopagoPreapprovalId: preapprovalId, organizationId },
            data: { status: 'completed', completedAt: new Date() },
          });
        } else if (status === 'payment_required') {
          await applyBillingEvent(organizationId, 'PAYMENT_FAILED', { preapprovalId });
          console.log('[Webhook] MercadoPago payment_required → grace period:', organizationId);
        } else if (status === 'cancelled' || status === 'expired') {
          const terminal = await applyBillingEvent(organizationId, 'MP_PREAPPROVAL_CANCELLED', {
            preapprovalId,
            mpStatus: status,
          });
          console.log('[Webhook] MercadoPago', status, '→', terminal.action, organizationId);
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

        const parsedRef = parseExternalReferenceV2(externalRef) || parseExternalReference(externalRef);
        const organizationId = parsedRef?.organizationId;
        const planSKU = parsedRef?.planSKU || 'plan-profesional';

        if (!organizationId) {
          console.warn('[Webhook] MercadoPago: payment external_reference inválido:', externalRef);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processingStatus: 'skipped', errorMessage: 'invalid external_reference' },
          });
          return;
        }

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
          refKind: parsedRef.kind,
        });

        if (parsedRef.kind === 'checkout_pro' || parsedRef.provider === 'mp_checkout_pro') {
          if (mpPayment.status === 'approved') {
            const cpResult = await mercadopagoCheckoutProService.processCheckoutProPayment(mpPayment);
            if (cpResult.activated) {
              await createReceiptFromMPPayment(mpPayment, organizationId, planSKU);
              console.log('[Webhook] Checkout Pro: suscripción activada/renovada:', organizationId);
            }
          } else if (mpPayment.status === 'rejected' || mpPayment.status === 'cancelled') {
            try {
              const org = await prisma.restaurantOrganization.findUnique({
                where: { id: organizationId },
                select: {
                  name: true,
                  owner: { select: { email: true } },
                },
              });
              const activeSub = await prisma.subscription.findFirst({
                where: { organizationId, isActiveSubscription: true },
                select: { id: true },
                orderBy: { createdAt: 'desc' },
              });
              const { handleCheckoutPaymentRejected } = require('../services/billing/billingEmailService');
              await handleCheckoutPaymentRejected({
                organizationId,
                subscriptionId: activeSub?.id,
                mpPayment,
                orgName: org?.name || organizationId,
                ownerEmail: org?.owner?.email,
              });
            } catch (rejectErr) {
              console.error('[Webhook] Checkout Pro rejected notify:', rejectErr?.message ?? rejectErr);
            }
          } else if (mpPayment.status === 'refunded' || mpPayment.status === 'charged_back') {
            try {
              // Revoke access immediately — refund/chargeback invalidates the payment.
              const revokedSub = await prisma.subscription.findFirst({
                where: { organizationId, isActiveSubscription: true },
                orderBy: { createdAt: 'desc' },
              });
              if (revokedSub) {
                await prisma.subscription.update({
                  where: { id: revokedSub.id },
                  data: { status: 'expired', isActiveSubscription: false, endDate: new Date() },
                });
                const planService = require('../services/planService');
                planService.invalidateCache(organizationId);
                console.log('[Webhook] Checkout Pro refund/chargeback: acceso revocado org:', organizationId, mpPayment.status);
              }
              await referralService.handlePaymentReversal(organizationId);
              const { createOpsAlert } = require('../services/billing/billingEmailService');
              const org = await prisma.restaurantOrganization.findUnique({
                where: { id: organizationId },
                select: { name: true },
              });
              await createOpsAlert({
                organizationId,
                subscriptionId: revokedSub?.id,
                kind: 'payment_reversal',
                severity: 'critical',
                title: `Reversión de pago Checkout Pro — ${org?.name || organizationId}`,
                detail: `paymentId=${paymentId} status=${mpPayment.status} — acceso revocado`,
                suggestedAction: 'Verificar si es error o fraude; restaurar acceso manualmente si corresponde.',
                dedupeKey: `org:${organizationId}:payment_reversal:${paymentId}`,
              });
              console.log('[Webhook] Checkout Pro payment reversal handled:', organizationId, mpPayment.status);
            } catch (refErr) {
              console.warn('[Webhook] Checkout Pro handlePaymentReversal failed:', refErr?.message ?? refErr);
            }
          }
          // Mark as 'processed' only for terminal statuses so that a pending→approved
          // sequence for the same payment ID can re-process on the second notification.
          const cpIsTerminal = ['approved', 'refunded', 'charged_back', 'cancelled', 'rejected'].includes(mpPayment.status);
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              processingStatus: cpIsTerminal ? 'processed' : 'skipped',
              mpStatus: mpPayment.status,
              organizationId,
              externalRef,
              normalizedKind: normalizeMercadoPagoWebhook({ type, data: { id: paymentId }, mpEntity: mpPayment })?.kind,
              processedAt: cpIsTerminal ? new Date() : null,
            },
          });
          return;
        }

        if (mpPayment.status === 'approved') {
          try {
            await persistPaymentMethodSnapshot(organizationId, mpPayment);
          } catch (e) {
            console.warn('[Webhook] payment method snapshot:', e?.message);
          }
          await createReceiptFromMPPayment(mpPayment, organizationId, planSKU);
          console.log('[Webhook] MercadoPago receipt created for payment:', paymentId);

          const referralFreeWindowService = require('../services/billing/referralFreeWindowService');
          const activeSubWithWindow = await prisma.subscription.findFirst({
            where: {
              organizationId,
              status: 'active',
              referralFreeUntil: { not: null },
            },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
          });
          if (activeSubWithWindow?.plan) {
            await referralFreeWindowService.clearReferralFreeWindowOnFirstPayment(
              activeSubWithWindow,
              activeSubWithWindow.plan,
            );
          }

          try {
            await referralService.markFirstPayment(organizationId);
          } catch (refErr) {
            console.warn('[Webhook] markFirstPayment failed:', refErr?.message ?? refErr);
          }
          // Reactivar acceso si estaba en periodo de gracia por fallo de cobro
          const reactivated = await prisma.subscription.updateMany({
            where: { organizationId, status: 'grace' },
            data: { status: 'active', gracePeriodEndsAt: null },
          });
          if (reactivated.count > 0) {
            const planService = require('../services/planService');
            planService.invalidateCache(organizationId);
            console.log('[Webhook] MercadoPago payment approved → grace cleared, org:', organizationId);
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
        } else if (mpPayment.status === 'refunded' || mpPayment.status === 'charged_back') {
          try {
            // Revoke access immediately — refund/chargeback invalidates the payment.
            const revokedSub = await prisma.subscription.findFirst({
              where: { organizationId, isActiveSubscription: true },
              orderBy: { createdAt: 'desc' },
            });
            if (revokedSub) {
              // Cancel the MP preapproval if present, to stop future charges
              if (revokedSub.mercadopagoPreapprovalId) {
                try {
                  const { cancelSubscription } = require('../services/mercadopagoService');
                  await cancelSubscription(revokedSub.mercadopagoPreapprovalId);
                } catch (cancelErr) {
                  console.warn('[Webhook] No se pudo cancelar preapproval en MP:', revokedSub.mercadopagoPreapprovalId, cancelErr?.message ?? cancelErr);
                }
              }
              await prisma.subscription.update({
                where: { id: revokedSub.id },
                data: { status: 'expired', isActiveSubscription: false, endDate: new Date(), mercadopagoPreapprovalId: null },
              });
              const planService = require('../services/planService');
              planService.invalidateCache(organizationId);
              console.log('[Webhook] Preapproval refund/chargeback: acceso revocado org:', organizationId, mpPayment.status);
            }
            await referralService.handlePaymentReversal(organizationId);
            const { createOpsAlert } = require('../services/billing/billingEmailService');
            const org = await prisma.restaurantOrganization.findUnique({
              where: { id: organizationId },
              select: { name: true },
            });
            await createOpsAlert({
              organizationId,
              subscriptionId: revokedSub?.id,
              kind: 'payment_reversal',
              severity: 'critical',
              title: `Reversión de pago — ${org?.name || organizationId}`,
              detail: `paymentId=${paymentId} status=${mpPayment.status} — acceso revocado`,
              suggestedAction: 'Verificar si es error o fraude; restaurar acceso manualmente si corresponde.',
              dedupeKey: `org:${organizationId}:payment_reversal:${paymentId}`,
            });
            console.log('[Webhook] Referral payment reversal handled for org:', organizationId, mpPayment.status);
          } catch (refErr) {
            console.warn('[Webhook] handlePaymentReversal failed:', refErr?.message ?? refErr);
          }
        } else if (mpPayment.status === 'rejected' || mpPayment.status === 'cancelled') {
          try {
            const org = await prisma.restaurantOrganization.findUnique({
              where: { id: organizationId },
              select: { name: true, owner: { select: { email: true } } },
            });
            const activeSub = await prisma.subscription.findFirst({
              where: { organizationId, isActiveSubscription: true },
              select: { id: true, status: true, billingStrategy: true, mercadopagoPreapprovalId: true },
              orderBy: { createdAt: 'desc' },
            });
            const { handleCheckoutPaymentRejected } = require('../services/billing/billingEmailService');
            await handleCheckoutPaymentRejected({
              organizationId,
              subscriptionId: activeSub?.id,
              mpPayment,
              orgName: org?.name || organizationId,
              ownerEmail: org?.owner?.email,
            });

            // MP no cambia el status del preapproval cuando un cobro recurrente falla
            // (solo reintenta por su cuenta); no podemos esperar esa señal para entrar
            // a periodo de gracia. Si esto es una renovación de una sub ya activa (y no
            // un primer intento de alta/cambio de plan en curso), reaccionar ahora mismo.
            const pendingCheckout = await prisma.checkoutSession.findFirst({
              where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } },
              select: { id: true },
            });
            if (shouldEnterGraceFromRejectedPayment({ activeSub, hasPendingCheckout: !!pendingCheckout })) {
              await applyBillingEvent(organizationId, 'PAYMENT_FAILED', {
                preapprovalId: activeSub.mercadopagoPreapprovalId,
              });
              console.log('[Webhook] MercadoPago payment rejected on active subscription → grace period:', organizationId);
            }
          } catch (rejectErr) {
            console.error('[Webhook] Preapproval payment rejected notify:', rejectErr?.message ?? rejectErr);
          }
        }

        const payIsTerminal = ['approved', 'refunded', 'charged_back', 'cancelled', 'rejected'].includes(mpPayment.status);
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            processingStatus: payIsTerminal ? 'processed' : 'skipped',
            mpStatus: mpPayment.status,
            organizationId,
            externalRef,
            normalizedKind: normalizeMercadoPagoWebhook({ type, data: { id: paymentId }, mpEntity: mpPayment })?.kind,
            processedAt: payIsTerminal ? new Date() : null,
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
