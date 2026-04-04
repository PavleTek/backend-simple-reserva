/**
 * Job de reconciliacion: detecta y corrige discrepancias entre el estado local y MercadoPago.
 *
 * Corre cada 6 horas (configurable via RECONCILIATION_CRON).
 *
 * Pasada 1: CheckoutSessions pendientes con mas de 2h.
 *   - Sin preapprovalId: marcar expired.
 *   - Con preapprovalId: consultar MP. Si authorized/approved, activar. Si cancelled/expired, marcar expired.
 *
 * Pasada 2: Subscriptions activas vs. MP.
 *   - Si MP dice cancelled/expired/payment_required: entrar grace period.
 *
 * Pasada 3: WebhookEvents fallidos de las ultimas 48h.
 *   - Reintentar procesamiento de eventos de tipo subscription_preapproval o payment.
 */

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const {
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  enterGracePeriod,
  getActivateOptionsForPreapproval,
} = require('../services/mercadopagoService');
const { createReceiptFromMPPayment } = require('../services/paymentReceiptService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReconciliation() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) {
    logger.warn('[Reconciliation] MERCADOPAGO_ACCESS_TOKEN no configurado, saltando reconciliacion');
    return;
  }

  const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');
  const mpClient = new MercadoPagoConfig({ accessToken });
  const preApprovalClient = new PreApproval(mpClient);
  const paymentClient = new Payment(mpClient);

  const now = new Date();
  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 horas

  console.log('[Reconciliation] Iniciando reconciliacion:', now.toISOString());

  // -----------------------------------------------------------------------
  // PASADA 1: CheckoutSessions pendientes con mas de 2 horas
  // -----------------------------------------------------------------------
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  let staleSessions;
  try {
    staleSessions = await prisma.checkoutSession.findMany({
      where: {
        status: 'pending',
        createdAt: { lt: twoHoursAgo },
      },
    });
  } catch (err) {
    console.error('[Reconciliation] Error consultando sessions:', err?.message);
    staleSessions = [];
  }

  console.log(`[Reconciliation] Pasada 1: ${staleSessions.length} checkout sessions pendientes para revisar.`);

  for (const session of staleSessions) {
    await sleep(100); // Rate limit suave contra MP API

    if (!session.mercadopagoPreapprovalId) {
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      }).catch(() => {});
      continue;
    }

    try {
      const mpSub = await preApprovalClient.get({ id: session.mercadopagoPreapprovalId });
      const status = mpSub?.status;

      if (status === 'authorized' || status === 'approved') {
        const parts = String(mpSub.external_reference || '').split('|');
        const orgId = parts[0];
        const planSKU = parts[1] || 'plan-profesional';

        // start_date futuro → scheduled, no activar
        const mpStartDate = mpSub?.auto_recurring?.start_date || mpSub?.start_date || mpSub?.date_created;
        const THRESHOLD_MS = 10 * 60 * 1000;
        const isFutureStart = mpStartDate && (new Date(mpStartDate).getTime() - Date.now() > THRESHOLD_MS);

        if (isFutureStart) {
          await scheduleOrganizationSubscription(orgId, session.mercadopagoPreapprovalId, planSKU, new Date(mpStartDate));
          console.warn(`[Reconciliation] Session scheduled (future start ${mpStartDate}): ${session.id} org=${orgId}`);
        } else {
          const activateOpts = await getActivateOptionsForPreapproval(orgId, session.mercadopagoPreapprovalId);
          await activateOrganizationSubscription(orgId, session.mercadopagoPreapprovalId, planSKU, activateOpts);
          console.warn(`[Reconciliation] WARN: Session activada por reconciliacion (webhook no llego): ${session.id} org=${orgId}`);
        }
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'completed', completedAt: new Date() },
        });
      } else if (status === 'cancelled' || status === 'expired') {
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'expired' },
        });
        console.log(`[Reconciliation] Session expirada: ${session.id} (MP status=${status})`);
      } else if (status === 'pending') {
        // Checkout abandonado (>2h): cancelar preapproval en MP (ej. cambio de plan sin completar pago)
        try {
          await preApprovalClient.update({
            id: session.mercadopagoPreapprovalId,
            body: { status: 'cancelled' },
          });
        } catch (e) {
          console.warn(`[Reconciliation] No se pudo cancelar preapproval pending session ${session.id}:`, e?.message);
        }
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'expired' },
        });
        console.log(`[Reconciliation] Session expirada (checkout abandonado, pending >2h): ${session.id}`);
      }
    } catch (err) {
      console.error(`[Reconciliation] Error revisando session ${session.id}:`, err?.message);
    }
  }

  // -----------------------------------------------------------------------
  // PASADA 2: Subscriptions activas localmente vs. estado en MP
  // -----------------------------------------------------------------------
  let activeSubs;
  try {
    activeSubs = await prisma.subscription.findMany({
      where: {
        status: 'active',
        mercadopagoPreapprovalId: { not: null },
      },
    });
  } catch (err) {
    console.error('[Reconciliation] Error consultando subscriptions activas:', err?.message);
    activeSubs = [];
  }

  console.log(`[Reconciliation] Pasada 2: ${activeSubs.length} subscriptions activas para verificar en MP.`);

  for (const sub of activeSubs) {
    await sleep(100);
    try {
      const mpSub = await preApprovalClient.get({ id: sub.mercadopagoPreapprovalId });
      const mpStatus = mpSub?.status;

      if (mpStatus === 'cancelled' || mpStatus === 'expired') {
        await enterGracePeriod(sub.organizationId);
        console.error(`[Reconciliation] ERROR: Sub ${sub.id} activa localmente pero MP dice ${mpStatus}. Entrando grace period. org=${sub.organizationId}`);
      } else if (mpStatus === 'payment_required') {
        // Solo entrar grace si aun no esta en grace
        const currentSub = await prisma.subscription.findUnique({ where: { id: sub.id } });
        if (currentSub?.status === 'active') {
          await enterGracePeriod(sub.organizationId);
          console.error(`[Reconciliation] ERROR: Sub ${sub.id} con payment_required en MP. Entrando grace period. org=${sub.organizationId}`);
        }
      }
      // MP status authorized/approved: todo OK, no tocar
    } catch (err) {
      console.error(`[Reconciliation] Error verificando sub ${sub.id}:`, err?.message);
    }
  }

  // -----------------------------------------------------------------------
  // PASADA 2b: Subscriptions 'scheduled' cuyo startDate ya pasó → activar
  // -----------------------------------------------------------------------
  let scheduledSubs;
  try {
    scheduledSubs = await prisma.subscription.findMany({
      where: {
        status: 'scheduled',
        startDate: { lte: now },
        mercadopagoPreapprovalId: { not: null },
      },
      include: { plan: true },
    });
  } catch (err) {
    console.error('[Reconciliation] Error consultando subscriptions scheduled:', err?.message);
    scheduledSubs = [];
  }

  console.log(`[Reconciliation] Pasada 2b: ${scheduledSubs.length} subscriptions scheduled para activar.`);

  for (const sSub of scheduledSubs) {
    await sleep(100);
    try {
      const mpSub = await preApprovalClient.get({ id: sSub.mercadopagoPreapprovalId });
      const mpStatus = mpSub?.status;

      if (mpStatus === 'authorized' || mpStatus === 'approved') {
        const planSKU = sSub.plan?.productSKU || 'plan-profesional';
        const activateOpts = await getActivateOptionsForPreapproval(sSub.organizationId, sSub.mercadopagoPreapprovalId);
        await activateOrganizationSubscription(sSub.organizationId, sSub.mercadopagoPreapprovalId, planSKU, activateOpts);
        console.log(`[Reconciliation] Scheduled sub ${sSub.id} activated: org=${sSub.organizationId} plan=${planSKU}`);
      } else if (mpStatus === 'cancelled' || mpStatus === 'expired') {
        await prisma.subscription.update({
          where: { id: sSub.id },
          data: { status: 'cancelled' },
        });
        console.log(`[Reconciliation] Scheduled sub ${sSub.id} cancelled (MP status=${mpStatus})`);
      }
    } catch (err) {
      console.error(`[Reconciliation] Error activando scheduled sub ${sSub.id}:`, err?.message);
    }
  }

  // -----------------------------------------------------------------------
  // PASADA 3: WebhookEvents fallidos de las ultimas 48h (reintentos)
  // -----------------------------------------------------------------------
  let failedEvents;
  try {
    failedEvents = await prisma.webhookEvent.findMany({
      where: {
        processingStatus: 'failed',
        createdAt: { gt: windowStart },
      },
    });
  } catch (err) {
    console.error('[Reconciliation] Error consultando WebhookEvents fallidos:', err?.message);
    failedEvents = [];
  }

  console.log(`[Reconciliation] Pasada 3: ${failedEvents.length} webhooks fallidos para reintentar.`);

  for (const event of failedEvents) {
    await sleep(100);
    try {
      if (event.mpEventType === 'subscription_preapproval') {
        const mpSub = await preApprovalClient.get({ id: event.mpDataId });
        const externalRef = mpSub?.external_reference;
        if (!externalRef) continue;

        const parts = String(externalRef).split('|');
        const orgId = parts[0];
        const planSKU = parts[1] || 'plan-profesional';
        const status = mpSub?.status;

        if (status === 'authorized' || status === 'approved') {
          const mpStartDate = mpSub?.auto_recurring?.start_date || mpSub?.start_date || mpSub?.date_created;
          const THRESHOLD_MS = 10 * 60 * 1000;
          const isFutureStart = mpStartDate && (new Date(mpStartDate).getTime() - Date.now() > THRESHOLD_MS);

          if (isFutureStart) {
            await scheduleOrganizationSubscription(orgId, event.mpDataId, planSKU, new Date(mpStartDate));
          } else {
            const activateOpts = await getActivateOptionsForPreapproval(orgId, event.mpDataId);
            await activateOrganizationSubscription(orgId, event.mpDataId, planSKU, activateOpts);
          }
        } else if (status === 'payment_required' || status === 'cancelled' || status === 'expired') {
          await enterGracePeriod(orgId, { scheduledPreapprovalId: event.mpDataId });
        }

        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            processingStatus: 'processed',
            mpStatus: status,
            organizationId: orgId,
            externalRef,
            processedAt: new Date(),
          },
        });
        console.log(`[Reconciliation] Reintento exitoso para webhook ${event.id} (${event.mpEventType})`);

      } else if (event.mpEventType === 'payment') {
        const mpPayment = await paymentClient.get({ id: event.mpDataId });
        if (mpPayment.status === 'approved') {
          const externalRef = mpPayment?.external_reference;
          if (!externalRef) continue;
          const parts = String(externalRef).split('|');
          const orgId = parts[0];
          const planSKU = parts[1] || 'plan-profesional';

          await createReceiptFromMPPayment(mpPayment, orgId, planSKU);

          const reactivated = await prisma.subscription.updateMany({
            where: { organizationId: orgId, status: 'grace' },
            data: { status: 'active', gracePeriodEndsAt: null },
          });
          if (reactivated.count > 0) {
            const planService = require('../services/planService');
            planService.invalidateCache(orgId);
          }

          await prisma.webhookEvent.update({
            where: { id: event.id },
            data: {
              processingStatus: 'processed',
              mpStatus: mpPayment.status,
              organizationId: orgId,
              externalRef,
              processedAt: new Date(),
            },
          });
          console.log(`[Reconciliation] Receipt creado en reintento para payment ${event.mpDataId}`);
        }
      }
    } catch (err) {
      console.error(`[Reconciliation] Reintento fallido para evento ${event.id}:`, err?.message);
      // No actualizar a failed de nuevo; se revisara en la proxima ejecucion
    }
  }

  logger.info({ at: new Date().toISOString() }, '[Reconciliation] completed');
}

function startReconciliationJob() {
  const schedule = process.env.RECONCILIATION_CRON || '0 */6 * * *'; // cada 6 horas
  cron.schedule(schedule, () => {
    runReconciliation().catch((err) => {
      logger.error({ err }, '[Reconciliation] job failed');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[ReconciliationJob] scheduled');
}

module.exports = { startReconciliationJob, runReconciliation };
