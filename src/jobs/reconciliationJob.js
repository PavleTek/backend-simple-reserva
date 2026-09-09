/**
 * Job de reconciliacion: detecta y corrige discrepancias entre el estado local y MercadoPago.
 *
 * Corre cada hora (configurable via RECONCILIATION_CRON).
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
const { getMercadoPagoAccessToken } = require('../lib/mercadopagoEnv');
const { recordJobRun } = require('./billingIntegrityJob');
const { withCronLock } = require('../lib/cronLock');
const {
  activateOrganizationSubscription,
  scheduleOrganizationSubscription,
  getActivateOptionsForPreapproval,
} = require('../services/mercadopagoService');
const { handlePreapprovalCancelledOrExpired } = require('../services/billing/handlePreapprovalTerminalStatus');
const { decideOverdueAutomaticSubAction } = require('../services/billing/paymentFailureDetection');
const { parseMpRetrySchedule } = require('../services/billing/retryScheduleService');
const { computePeriodEnd } = require('../lib/billingPeriod');
const { withMpRetry } = require('../lib/mpRetry');
const { resolvePreapprovalIdFromAuthorizedPayment } = require('../lib/mpAuthorizedPayment');
const { createReceiptFromMPPayment } = require('../services/paymentReceiptService');
const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');
const { parseExternalReferenceV2 } = require('../lib/externalReferenceV2');
const { parseExternalReference } = require('../lib/billingProviders');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFlowReconciliation(now) {
  const { getFlowApiKey, getFlowSecretKey } = require('../lib/flowEnv');
  if (!getFlowApiKey() || !getFlowSecretKey()) {
    logger.warn('[Reconciliation] Flow credentials missing, skipping Flow pass');
    return;
  }

  const flowService = require('../services/flowService');
  const { handleFlowSubscriptionCancelled } = require('../services/billing/handleFlowSubscriptionTerminalStatus');

  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const staleFlowSessions = await prisma.checkoutSession.findMany({
    where: {
      status: 'pending',
      paymentProvider: 'flow',
      createdAt: { lt: twoHoursAgo },
    },
  }).catch(() => []);

  for (const session of staleFlowSessions) {
    if (!session.flowRegisterToken) {
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      }).catch(() => {});
      continue;
    }
    try {
      const statusPayload = await flowService.getRegisterStatus(session.flowRegisterToken);
      if (statusPayload && (statusPayload.status === 1 || statusPayload.status === '1')) {
        await flowService.confirmFromRegisterToken(session.organizationId, session.flowRegisterToken);
      } else {
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'expired' },
        });
      }
    } catch (err) {
      logger.error({ err, sessionId: session.id }, '[Reconciliation] Flow session error');
    }
  }

  const flowSubs = await prisma.subscription.findMany({
    where: {
      flowSubscriptionId: { not: null },
      status: { in: ['active', 'grace', 'scheduled'] },
    },
  }).catch(() => []);

  logger.info({ count: flowSubs.length }, '[Reconciliation] Flow subscriptions');

  for (const sub of flowSubs) {
    await sleep(100);
    try {
      if (sub.status === 'scheduled' && sub.startDate && sub.startDate <= now) {
        const remote = await flowService.getFlowSubscription(sub.flowSubscriptionId);
        if (Number(remote?.status) === 1) {
          const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });
          if (plan) {
            const { activateOrganizationSubscription } = require('../services/mercadopagoService');
            await activateOrganizationSubscription(sub.organizationId, null, plan.productSKU, {
              flowSubscriptionId: sub.flowSubscriptionId,
              flowPlanId: sub.flowPlanId,
              paymentProviderPsp: 'flow',
            });
            logger.info({ subId: sub.id }, '[Reconciliation] Flow scheduled sub activated');
          }
        } else {
          await handleFlowSubscriptionCancelled(sub.organizationId, sub.flowSubscriptionId, String(remote?.status));
        }
        continue;
      }
      await flowService.syncLocalSubscriptionFromFlow(sub);
    } catch (err) {
      logger.error({ err, subId: sub.id }, '[Reconciliation] Flow sub error');
    }
  }

  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const failedFlowEvents = await prisma.webhookEvent.findMany({
    where: {
      provider: 'flow',
      processingStatus: 'failed',
      createdAt: { gt: windowStart },
      mpEventType: 'flow_payment',
    },
  }).catch(() => []);

  for (const event of failedFlowEvents) {
    await sleep(100);
    try {
      const result = await flowService.processFlowPaymentNotification(event.mpDataId);
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processingStatus: result?.skipped ? 'skipped' : 'processed',
          organizationId: result?.organizationId || null,
          mpStatus: result?.processed || result?.skipped || null,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      logger.error({ err, eventId: event.id }, '[Reconciliation] Flow webhook retry failed');
    }
  }
}

async function runReconciliation() {
  const now = new Date();
  try {
    await runFlowReconciliation(now);
  } catch (err) {
    logger.error({ err }, '[Reconciliation] Flow pass failed');
  }

  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    logger.warn('[Reconciliation] MERCADOPAGO_ACCESS_TOKEN no configurado, saltando pasada MP');
    return;
  }

  const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');
  const mpClient = new MercadoPagoConfig({ accessToken });
  const preApprovalClient = new PreApproval(mpClient);
  const paymentClient = new Payment(mpClient);

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

    if (session.paymentProvider === 'flow') {
      continue;
    }

    if (!session.mercadopagoPreapprovalId) {
      // Checkout Pro session: buscar pagos aprobados por external_reference en MP
      if (session.mercadopagoPreferenceId) {
        try {
          const searchRes = await withMpRetry(() => paymentClient.search({
            options: { external_reference: session.id, limit: 5 },
          }));
          const approvedPayment = searchRes?.results?.find((p) => p.status === 'approved');
          if (approvedPayment) {
            const cpResult = await mercadopagoCheckoutProService.processCheckoutProPayment(approvedPayment);
            if (cpResult.activated) {
              await createReceiptFromMPPayment(approvedPayment, session.organizationId, null);
              await prisma.checkoutSession.update({
                where: { id: session.id },
                data: { status: 'completed', completedAt: new Date() },
              }).catch(() => {});
              console.warn(`[Reconciliation] Checkout Pro session ${session.id} activada por reconciliacion org=${session.organizationId}`);
              continue;
            }
          }
        } catch (cpErr) {
          console.error(`[Reconciliation] Error buscando pago Checkout Pro para session ${session.id}:`, cpErr?.message);
        }
      }
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      }).catch(() => {});
      continue;
    }

    try {
      const mpSub = await withMpRetry(() => preApprovalClient.get({ id: session.mercadopagoPreapprovalId }));
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
          const referralFreeWindowService = require('../services/billing/referralFreeWindowService');
          const isReferralWindow = await referralFreeWindowService.isReferralFreeWindowPreapproval(
            orgId,
            session.mercadopagoPreapprovalId,
          );
          if (isReferralWindow) {
            const activateOpts = await getActivateOptionsForPreapproval(orgId, session.mercadopagoPreapprovalId);
            await activateOrganizationSubscription(orgId, session.mercadopagoPreapprovalId, planSKU, {
              ...activateOpts,
              referralFreeUntil: new Date(mpStartDate),
              skipMarkFirstPayment: true,
            });
            console.warn(`[Reconciliation] Session referral free window: ${session.id} org=${orgId}`);
          } else {
            await scheduleOrganizationSubscription(orgId, session.mercadopagoPreapprovalId, planSKU, new Date(mpStartDate));
            console.warn(`[Reconciliation] Session scheduled (future start ${mpStartDate}): ${session.id} org=${orgId}`);
          }
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
      const mpSub = await withMpRetry(() => preApprovalClient.get({ id: sub.mercadopagoPreapprovalId }));
      const mpStatus = mpSub?.status;

      if (mpStatus === 'cancelled' || mpStatus === 'expired') {
        // Usar handlePreapprovalCancelledOrExpired en lugar de enterGracePeriod:
        // respeta el periodo pagado restante (cancel_at_period_end) en lugar de siempre dar +7d.
        await handlePreapprovalCancelledOrExpired(sub.organizationId, sub.mercadopagoPreapprovalId, mpStatus);
        console.error(`[Reconciliation] ERROR: Sub ${sub.id} activa localmente pero MP dice ${mpStatus}. Aplicado terminal handler. org=${sub.organizationId}`);
      } else if (mpStatus === 'payment_required') {
        // Nota: la API actual de MP no documenta este status para preapproval (solo
        // pending|authorized|paused|cancelled); se deja como red de seguridad por si
        // MP lo reintroduce. La detección real de mora está en la rama de abajo.
        const currentSub = await prisma.subscription.findUnique({ where: { id: sub.id } });
        if (currentSub?.status === 'active') {
          const { enterGracePeriod } = require('../services/mercadopagoService');
          await enterGracePeriod(sub.organizationId);
          console.error(`[Reconciliation] ERROR: Sub ${sub.id} con payment_required en MP. Entrando grace period. org=${sub.organizationId}`);
        }
      } else if (mpStatus === 'authorized' || mpStatus === 'approved') {
        // MP no cambia el status del preapproval cuando falla un cobro recurrente (solo
        // reintenta internamente hasta 4 veces en ~10 días); por eso anclamos la
        // detección de mora al currentPeriodEnd propio en vez de a un status de MP.
        const { lastChargedAt } = parseMpRetrySchedule(mpSub);
        const decision = decideOverdueAutomaticSubAction({
          mpStatus: 'authorized',
          currentPeriodEnd: sub.currentPeriodEnd,
          lastChargedDate: lastChargedAt ? new Date(lastChargedAt) : null,
          now,
        });
        if (decision.action === 'sync_period_end') {
          const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });
          const nextPeriod = plan ? computePeriodEnd(new Date(lastChargedAt), plan) : null;
          if (nextPeriod) {
            await prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: nextPeriod } });
            console.warn(`[Reconciliation] Sub ${sub.id}: currentPeriodEnd desincronizado (MP sí cobró), corregido. org=${sub.organizationId}`);
          }
        } else if (decision.action === 'enter_grace') {
          const currentSub = await prisma.subscription.findUnique({ where: { id: sub.id } });
          if (currentSub?.status === 'active') {
            const { enterGracePeriod } = require('../services/mercadopagoService');
            await enterGracePeriod(sub.organizationId);
            console.error(`[Reconciliation] ERROR: Sub ${sub.id} vencida (currentPeriodEnd=${sub.currentPeriodEnd?.toISOString()}) sin cobro nuevo en MP. Entrando grace period. org=${sub.organizationId}`);
          }
        }
      }
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
      const mpSub = await withMpRetry(() => preApprovalClient.get({ id: sSub.mercadopagoPreapprovalId }));
      const mpStatus = mpSub?.status;

      if (mpStatus === 'authorized' || mpStatus === 'approved') {
        const planSKU = sSub.plan?.productSKU || 'plan-profesional';
        const activateOpts = await getActivateOptionsForPreapproval(sSub.organizationId, sSub.mercadopagoPreapprovalId);
        await activateOrganizationSubscription(sSub.organizationId, sSub.mercadopagoPreapprovalId, planSKU, activateOpts);
        console.log(`[Reconciliation] Scheduled sub ${sSub.id} activated: org=${sSub.organizationId} plan=${planSKU}`);
      } else if (mpStatus === 'cancelled' || mpStatus === 'expired') {
        await prisma.subscription.update({
          where: { id: sSub.id },
          data: { status: 'cancelled', isActiveSubscription: false },
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
        OR: [
          { processingStatus: 'failed', createdAt: { gt: windowStart } },
          // Recoger eventos subscription_authorized_payment que fueron descartados antes del fix
          {
            processingStatus: 'skipped',
            mpEventType: 'subscription_authorized_payment',
            createdAt: { gt: windowStart },
          },
        ],
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
      if (event.mpEventType === 'subscription_preapproval' || event.mpEventType === 'subscription_authorized_payment') {
        // Para subscription_authorized_payment, mpDataId es el id del cobro (authorized
        // payment), NO el preapproval id — hay que resolverlo antes de consultar GET /preapproval.
        // Reutilizar mpDataId como preapproval id (bug anterior) hacía que MP devolviera 404
        // ("resource not found") y el reintento fallara para siempre hasta salir de la ventana
        // de 48h, sin activar nunca la suscripción.
        let preapprovalId = event.mpDataId;
        if (event.mpEventType === 'subscription_authorized_payment') {
          try {
            preapprovalId = await resolvePreapprovalIdFromAuthorizedPayment(event.mpDataId, accessToken);
          } catch (apErr) {
            if (apErr.noPreapprovalId) {
              await prisma.webhookEvent.update({
                where: { id: event.id },
                data: { processingStatus: 'processed', errorMessage: 'no preapproval_id en authorized_payment (reintento)', processedAt: new Date() },
              });
              console.warn(`[Reconciliation] Sin preapproval_id en authorized_payment ${event.mpDataId}, evento no accionable`);
              continue;
            }
            throw apErr;
          }
        }

        const mpSub = await withMpRetry(() => preApprovalClient.get({ id: preapprovalId }));
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
            const referralFreeWindowService = require('../services/billing/referralFreeWindowService');
            const isReferralWindow = await referralFreeWindowService.isReferralFreeWindowPreapproval(
              orgId,
              preapprovalId,
            );
            if (isReferralWindow) {
              const activateOpts = await getActivateOptionsForPreapproval(orgId, preapprovalId);
              await activateOrganizationSubscription(orgId, preapprovalId, planSKU, {
                ...activateOpts,
                referralFreeUntil: new Date(mpStartDate),
                skipMarkFirstPayment: true,
              });
            } else {
              await scheduleOrganizationSubscription(orgId, preapprovalId, planSKU, new Date(mpStartDate));
            }
          } else {
            const activateOpts = await getActivateOptionsForPreapproval(orgId, preapprovalId);
            await activateOrganizationSubscription(orgId, preapprovalId, planSKU, activateOpts);
          }
        } else if (status === 'payment_required' || status === 'cancelled' || status === 'expired') {
          await enterGracePeriod(orgId, { scheduledPreapprovalId: preapprovalId });
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
        const mpPayment = await withMpRetry(() => paymentClient.get({ id: event.mpDataId }));
        if (mpPayment.status === 'approved') {
          const externalRef = mpPayment?.external_reference;
          if (!externalRef) continue;

          const parsedRef = parseExternalReferenceV2(externalRef) || parseExternalReference(externalRef);
          const orgId = parsedRef?.organizationId || String(externalRef).split('|')[0];
          const planSKU = parsedRef?.planSKU || String(externalRef).split('|')[1] || 'plan-profesional';

          if (parsedRef?.kind === 'checkout_pro' || parsedRef?.provider === 'mp_checkout_pro') {
            // Checkout Pro: route through the proper processor that activates the sub
            const cpResult = await mercadopagoCheckoutProService.processCheckoutProPayment(mpPayment);
            if (cpResult.activated) {
              await createReceiptFromMPPayment(mpPayment, orgId, planSKU);
              console.log(`[Reconciliation] Checkout Pro activado en reintento para payment ${event.mpDataId} org=${orgId}`);
            }
          } else {
            await createReceiptFromMPPayment(mpPayment, orgId, planSKU);

            const reactivated = await prisma.subscription.updateMany({
              where: { organizationId: orgId, status: 'grace' },
              data: { status: 'active', gracePeriodEndsAt: null },
            });
            if (reactivated.count > 0) {
              const planService = require('../services/planService');
              planService.invalidateCache(orgId);
            }
            console.log(`[Reconciliation] Receipt creado en reintento para payment ${event.mpDataId}`);
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
        }
      }
    } catch (err) {
      console.error(`[Reconciliation] Reintento fallido para evento ${event.id}:`, err?.message);
      // No actualizar a failed de nuevo; se revisara en la proxima ejecucion
    }
  }

  logger.info({ at: new Date().toISOString() }, '[Reconciliation] completed');
  recordJobRun('reconciliation');
}

function startReconciliationJob() {
  // Cada hora por defecto (antes 6h): a escala actual (decenas de orgs) el costo extra
  // contra la API de MP es insignificante y acota mucho cuánto tiempo puede quedar un
  // cliente mal reflejado si un webhook falla por una falla de red transitoria.
  const schedule = process.env.RECONCILIATION_CRON || '0 * * * *';
  cron.schedule(schedule, () => {
    withCronLock('reconciliation', runReconciliation).catch((err) => {
      logger.error({ err }, '[Reconciliation] job failed');
    });
  }, {
    timezone: process.env.TZ || 'America/Santiago',
  });
  logger.info({ schedule }, '[ReconciliationJob] scheduled');
}

module.exports = { startReconciliationJob, runReconciliation, runFlowReconciliation };
