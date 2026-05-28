const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { getActiveSubscription, hasActiveAccess, isTrialing, getOrganizationWithTrial } = require('../services/subscriptionService');
const planService = require('../services/planService');
const { sortPlansByDisplayOrder } = require('../lib/planDisplayOrder');
const { computePeriodEnd, estimateNextPaymentDate } = require('../lib/billingPeriod');
const { getMercadoPagoCheckoutHints } = require('../services/mercadopagoService');

function isValidPayerEmail(email) {
  const e = (email || '').trim();
  return e.length > 3 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * Guarda billingEmail (correo MP Chile) y devuelve el payer_email para la API.
 * @throws {Error} statusCode 400 si falta o es inválido el correo
 */
async function persistMercadoPagoPayerEmail(organizationId, bodyEmail, loginEmail) {
  const fromBody = (bodyEmail || '').trim();
  if (fromBody) {
    if (!isValidPayerEmail(fromBody)) {
      const err = new Error('Indica un correo electrónico válido para Mercado Pago Chile.');
      err.statusCode = 400;
      throw err;
    }
    const normalized = fromBody.toLowerCase();
    await prisma.restaurantOrganization.update({
      where: { id: organizationId },
      data: { billingEmail: normalized },
    });
    return normalized;
  }

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { billingEmail: true },
  });
  const stored = (org?.billingEmail || '').trim();
  if (stored && isValidPayerEmail(stored)) return stored.toLowerCase();

  const login = (loginEmail || '').trim();
  if (login && isValidPayerEmail(login)) return login.toLowerCase();

  const err = new Error(
    'Indica el correo de tu cuenta Mercado Pago Chile (mercadopagoPayerEmail). Debe ser el mismo que usarás al pagar.',
  );
  err.statusCode = 400;
  throw err;
}

function sendCheckoutJson(res, checkoutUrl, mercadopagoPayerEmail) {
  res.json({
    checkoutUrl,
    mercadopagoPayerEmail: mercadopagoPayerEmail || null,
    checkoutHints: getMercadoPagoCheckoutHints(mercadopagoPayerEmail),
  });
}

function handleBillingRouteError(error, res, next, respondMp) {
  if (error.statusCode === 400) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error.message?.includes('BACKEND_PUBLIC_URL') || error.message?.includes('MP_TEST_PAYER')) {
    res.status(400).json({ error: error.message });
    return;
  }
  respondMp(error, res, next);
}

/**
 * Verifica que la organización puede suscribirse al plan.
 * Los planes públicos (isDefault=true) siempre están disponibles.
 * Los planes privados requieren que estén asignados via customPlanId (legacy)
 * o que exista un CustomPlanOffer para esta org.
 * Retorna true si está permitido, false si no.
 */
async function orgCanUsePlan(organizationId, plan) {
  if (plan.isDefault) return true;

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    select: { customPlanId: true },
  });

  if (org?.customPlanId === plan.id) return true;

  const offer = await prisma.customPlanOffer.findUnique({
    where: { planId_organizationId: { planId: plan.id, organizationId } },
  });

  return !!offer;
}

/** True si la sub programada es renovación del mismo plan al vencer el periodo (no un cambio de plan). */
function isSamePlanRenewalScheduled(sub, scheduledSub) {
  if (!sub || !scheduledSub) return false;
  if (sub.status !== 'cancelled' || !sub.endDate || new Date() >= sub.endDate) return false;
  const skuA = sub.plan?.productSKU;
  const skuB = scheduledSub.plan?.productSKU;
  if (!skuA || !skuB || skuA !== skuB) return false;
  if (!scheduledSub.startDate || !sub.endDate) return false;
  const driftMs = Math.abs(
    new Date(scheduledSub.startDate).getTime() - new Date(sub.endDate).getTime()
  );
  // Reactivate / MP usan la misma fecha límite; tolerancia por zona horaria o redondeo
  return driftMs <= 48 * 60 * 60 * 1000;
}

/** Respuesta HTTP para fallos al crear preapproval en MP (checkout / change-plan / reactivate). */
function respondMercadoPagoCheckoutError(error, res, next) {
  if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
    res.status(503).json({ error: 'Configuración de pagos no disponible. Contacta a soporte.' });
    return;
  }
  if (error.mpPolicyBlocked) {
    res.status(502).json({
      error: 'checkout_mp_policy_blocked',
      message:
        'Mercado Pago rechazó crear la suscripción. Revisa que tu aplicación en developers.mercadopago.cl tenga Suscripciones activo.',
    });
    return;
  }
  if (error.mpPayerCountryMismatch) {
    res.status(400).json({
      error: 'checkout_mp_payer_country',
      message: error.message,
    });
    return;
  }
  if (error.message?.includes('MercadoPago') || error.message?.includes('temporalmente no disponible')) {
    res.status(502).json({ error: error.message });
    return;
  }
  next(error);
}

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

/** Facturación completa: solo propietario y gerente (anfitriones usan GET /access-status). */
const ROLES_BILLING = ['restaurant_owner', 'restaurant_manager'];

router.get('/subscription', authenticateRestaurantRoles(ROLES_BILLING), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const org = await getOrganizationWithTrial(organizationId);
    const sub = await getActiveSubscription(organizationId);
    const trialing = await isTrialing(organizationId);
    const hasAccess = await hasActiveAccess(organizationId);

    const inGrace = sub?.status === 'grace' && sub?.gracePeriodEndsAt && new Date() < sub.gracePeriodEndsAt;
    const cancelAtEndDate = sub?.status === 'cancelled' && sub?.endDate ? sub.endDate.toISOString() : null;

    let status;
    // Una suscripción paga activa siempre tiene precedencia sobre el periodo de prueba.
    // trialEndsAt puede quedar vigente en la org si el pago se procesó por rutas que no
    // lo limpian (webhook de payment, asignación manual de admin, etc.).
    if (sub?.status === 'active') {
      status = 'active';
    } else if (inGrace) {
      status = 'grace';
    } else if (trialing) {
      status = 'trial';
    } else if (cancelAtEndDate) {
      // Cancelada pero con acceso hasta endDate: mostrar como 'cancelled' para que
      // el UI ofrezca "Activar" en lugar de "Cambiar plan" (change-plan busca status='active')
      status = 'cancelled';
    } else {
      status = 'expired';
    }

    let plan = sub?.plan || null;
    if (!plan && trialing) {
      const trialSub = await prisma.subscription.findFirst({
        where: { organizationId, status: 'trial' },
        include: { plan: true },
      });
      plan = trialSub?.plan || null;
    }
    
    // Fallback to org's default plan if still null
    if (!plan) {
      const orgWithPlan = await prisma.restaurantOrganization.findUnique({
        where: { id: organizationId },
        include: { plan: true }
      });
      plan = orgWithPlan?.plan || null;
    }

    const planConfig = hasAccess ? await planService.resolvePlanConfigForRestaurant(restaurantId, true) : null;

    // Restaurantes activos de la organización (para saber si puede agregar más)
    const restaurantCount = await prisma.restaurant.count({ where: { organizationId, isDeleted: false } });

    // Planes disponibles para el owner: públicos + plan personalizado (legacy) + planes ofrecidos
    const [orgWithCustomPlan, publicPlans, planOffers] = await Promise.all([
      prisma.restaurantOrganization.findUnique({
        where: { id: organizationId },
        include: { customPlan: true },
      }),
      prisma.plan.findMany({ where: { isDefault: true } }),
      prisma.customPlanOffer.findMany({
        where: { organizationId },
        include: { plan: true },
      }),
    ]);
    const customPlan = orgWithCustomPlan?.customPlan ?? null;

    // Si tiene plan personalizado (legacy) y no está ya en la lista pública, agregarlo
    let allPlansForOrg = [...publicPlans];
    if (customPlan && !publicPlans.some((p) => p.id === customPlan.id)) {
      allPlansForOrg = [...allPlansForOrg, customPlan];
    }

    // Planes ofrecidos explícitamente via CustomPlanOffer (excluir duplicados ya en allPlans)
    const allPlanIds = new Set(allPlansForOrg.map((p) => p.id));
    const offeredPlans = sortPlansByDisplayOrder(
      planOffers.map((o) => o.plan).filter((p) => !allPlanIds.has(p.id))
    );

    const trialSubForDates = trialing
      ? await prisma.subscription.findFirst({
          where: { organizationId, status: 'trial' },
          orderBy: { startDate: 'desc' },
        })
      : null;

    const restaurantRows = await prisma.restaurant.findMany({
      where: { organizationId, isDeleted: false },
      select: { id: true },
    });
    const restaurantIdList = restaurantRows.map((r) => r.id);

    const [zoneCount, tableCount, managerCount] = await Promise.all([
      restaurantIdList.length
        ? prisma.zone.count({ where: { restaurantId: { in: restaurantIdList } } })
        : 0,
      restaurantIdList.length
        ? prisma.restaurantTable.count({
            where: { zone: { restaurantId: { in: restaurantIdList } } },
          })
        : 0,
      prisma.organizationManager.count({ where: { organizationId } }),
    ]);
    const teamMemberCount = 1 + managerCount;

    const zonesMax =
      planConfig?.maxZonesPerRestaurant == null
        ? null
        : planConfig.maxZonesPerRestaurant * restaurantCount;
    const tablesMax =
      planConfig?.maxTables == null ? null : planConfig.maxTables * restaurantCount;
    const teamMembersMax =
      planConfig?.maxTeamMembers == null ? null : planConfig.maxTeamMembers * restaurantCount;

    const subscriptionStartDate =
      sub?.startDate?.toISOString() ?? trialSubForDates?.startDate?.toISOString() ?? null;
    const nextPaymentDate =
      sub?.status === 'active' && sub.currentPeriodEnd
        ? sub.currentPeriodEnd.toISOString()
        : estimateNextPaymentDate(sub, planConfig);

    // cancelAtEndDate: cuando la sub está cancelada pero tiene acceso hasta endDate
    const canReactivateBase = !!(sub?.status === 'cancelled' && sub?.endDate && new Date() < sub.endDate);

    const currentPeriodEnd = cancelAtEndDate ?? nextPaymentDate ?? null;

    // Buscar suscripción programada (status='scheduled') para esta org
    const scheduledSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'scheduled' },
      orderBy: { startDate: 'desc' },
      include: { plan: true },
    });

    const renewalScheduledSamePlan = isSamePlanRenewalScheduled(sub, scheduledSub);
    const renewalScheduledAt = renewalScheduledSamePlan ? scheduledSub.startDate.toISOString() : null;

    // Renovación del mismo plan: no exponer scheduledPlan como "cambio" (evita doble banner / mismo plan "cancelado y programado")
    let scheduledPlanOut = scheduledSub?.plan?.productSKU ?? null;
    let scheduledPlanNameOut = scheduledSub?.plan?.name ?? null;
    let scheduledDateOut = scheduledSub?.startDate?.toISOString() ?? null;
    if (renewalScheduledSamePlan) {
      scheduledPlanOut = null;
      scheduledPlanNameOut = null;
      scheduledDateOut = null;
    }

    // Si ya tiene una sub scheduled, no puede reactivar (ya eligió)
    const canReactivate = canReactivateBase && !scheduledSub;

    res.json({
      plan: plan?.productSKU || 'plan-basico',
      status,
      trialEndsAt: org?.trialEndsAt?.toISOString() ?? null,
      cancelAtEndDate,
      currentPeriodEnd,
      paymentGracePeriod: inGrace,
      gracePeriodEndsAt: sub?.gracePeriodEndsAt?.toISOString() ?? null,
      hasAccess,
      canActivate: status !== 'active',
      canReactivate,
      renewalScheduledSamePlan,
      renewalScheduledAt,
      scheduledPlan: scheduledPlanOut,
      scheduledPlanName: scheduledPlanNameOut,
      scheduledDate: scheduledDateOut,
      hasCustomPlan: !!customPlan,
      restaurantCount,
      maxRestaurants: planConfig?.maxRestaurants ?? 1,
      zoneCount,
      tableCount,
      teamMemberCount,
      zonesMax,
      tablesMax,
      teamMembersMax,
      subscriptionStartDate,
      nextPaymentDate,
      planConfig: planConfig ? {
        name: planConfig.name,
        description: planConfig.description,
        priceCLP: planConfig.priceCLP,
        billingFrequency: planConfig.billingFrequency,
        billingFrequencyType: planConfig.billingFrequencyType,
        maxRestaurants: planConfig.maxRestaurants,
        maxZonesPerRestaurant: planConfig.maxZonesPerRestaurant,
        maxTables: planConfig.maxTables,
        maxTeamMembers: planConfig.maxTeamMembers,
        multipleMenu: planConfig.multipleMenu,
        whatsappFeatures: planConfig.whatsappFeatures,
        googleReserveIntegration: planConfig.googleReserveIntegration,
        prioritySupport: planConfig.prioritySupport,
        postVisitFeedback: planConfig.postVisitFeedback === true,
      } : null,
      allPlans: sortPlansByDisplayOrder(allPlansForOrg),
      offeredPlans,
      billingEmail: orgWithCustomPlan?.billingEmail ?? null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/billing/payments', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');

    const receipts = await prisma.paymentReceipt.findMany({
      where: { organizationId: restaurant.organizationId },
      orderBy: { paymentDate: 'desc' },
      take: 20,
      include: { plan: { select: { name: true } } },
    });

    const payments = receipts.map((r) => ({
      id: r.id,
      paymentDate: r.paymentDate.toISOString(),
      amount: Number(r.amount),
      currency: r.currency,
      status: r.mercadopagoStatus ?? 'unknown',
      planName: r.plan?.name ?? '—',
      receiptType: r.receiptType,
    }));

    res.json({ payments });
  } catch (error) {
    next(error);
  }
});

router.post('/billing/checkout', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const planSKU = req.body?.plan || 'plan-profesional';
    const when = req.body?.when === 'end_of_trial' ? 'end_of_trial' : 'now';

    // Buscar el plan: puede ser público o personalizado para esta org
    const plan = await prisma.plan.findUnique({
      where: { productSKU: planSKU },
    });
    if (!plan) throw new Error(`Plan no encontrado: ${planSKU}`);

    if (plan.comingSoon) {
      return res.status(400).json({ error: 'Este plan aún no está disponible. Pronto podrás contratarlo.' });
    }

    // Verificar que el plan es accesible para esta org
    if (!(await orgCanUsePlan(organizationId, plan))) {
      return res.status(403).json({ error: 'Este plan no está disponible para tu cuenta.' });
    }

    // Anti-doble-checkout: si ya existe una sesion pendiente no expirada para el MISMO plan, retornar esa URL
    const pendingSession = await prisma.checkoutSession.findFirst({
      where: {
        organizationId,
        planId: plan.id,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (pendingSession) {
      if (pendingSession.checkoutUrl) {
        const orgBilling = await prisma.restaurantOrganization.findUnique({
          where: { id: organizationId },
          select: { billingEmail: true },
        });
        return sendCheckoutJson(res, pendingSession.checkoutUrl, orgBilling?.billingEmail);
      }
      // Sin URL (fallo la creacion anterior): expirar y seguir
      await prisma.checkoutSession.update({
        where: { id: pendingSession.id },
        data: { status: 'expired' },
      });
    }

    // Create CheckoutSession
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        organizationId,
        userId: req.user.id,
        planId: plan.id,
        status: 'pending',
        expiresAt,
      },
    });

    const mercadopagoService = require('../services/mercadopagoService');
    const { isTrialing } = require('../services/subscriptionService');

    let createSubscriptionOptions = {};
    if (when === 'end_of_trial') {
      const trialing = await isTrialing(organizationId);
      if (!trialing) {
        return res.status(400).json({ error: 'Esta opción solo aplica durante la prueba gratuita.' });
      }
      const orgRow = await prisma.restaurantOrganization.findUnique({
        where: { id: organizationId },
        select: { trialEndsAt: true },
      });
      if (!orgRow?.trialEndsAt || new Date(orgRow.trialEndsAt) <= new Date()) {
        return res.status(400).json({ error: 'No tienes una prueba activa o ya venció.' });
      }
      createSubscriptionOptions = { startDate: orgRow.trialEndsAt };
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const mercadopagoPayerEmail = await persistMercadoPagoPayerEmail(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
    );

    const result = await mercadopagoService.createSubscription(
      organizationId,
      req.user.id,
      user?.email,
      planSKU,
      restaurantId,
      createSubscriptionOptions
    );

    const checkoutUrl = result?.init_point ?? result?.initPoint ?? null;
    const preapprovalId = result?.id ?? null;

    // Update CheckoutSession with MP info
    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: {
        mercadopagoPreapprovalId: preapprovalId,
        checkoutUrl,
      },
    });

    sendCheckoutJson(res, checkoutUrl, mercadopagoPayerEmail);
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
});

router.post('/billing/confirm', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const preapprovalId = req.body?.preapprovalId?.trim();
    if (!preapprovalId) {
      return res.status(400).json({ error: 'preapprovalId requerido' });
    }
    const mercadopagoService = require('../services/mercadopagoService');
    const result = await mercadopagoService.confirmSubscriptionFromPreapproval(organizationId, preapprovalId);
    if (result.activated) {
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
      return res.json({ ok: true, message: 'Suscripción activada' });
    }
    if (result.scheduled) {
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
      return res.json({
        ok: true,
        scheduled: true,
        scheduledDate: result.scheduledDate,
        planSKU: result.planSKU,
        message: 'Suscripción programada',
      });
    }
    return res.json({ ok: false, message: result.reason || 'Pago aún no autorizado' });
  } catch (error) {
    if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
      return res.status(503).json({ error: 'Configuración de pagos no disponible.' });
    }
    next(error);
  }
});

router.post('/billing/cancel', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const sub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'active' },
      orderBy: { startDate: 'desc' },
      include: { plan: true }
    });
    if (!sub) {
      res.status(400).json({ error: 'No hay suscripción activa para cancelar.' });
      return;
    }

    // Cancelar en MercadoPago solo si hay un preapproval vinculado.
    // Suscripciones asignadas manualmente por admin no tienen preapproval; se cancelan solo localmente.
    if (sub.mercadopagoPreapprovalId) {
      const mercadopagoService = require('../services/mercadopagoService');
      await mercadopagoService.cancelSubscription(sub.mercadopagoPreapprovalId);
    }

    // Calcular el fin real del periodo ya pagado: anclar en currentPeriodEnd o startDate + periodicidad
    const periodEnd = sub.currentPeriodEnd ?? computePeriodEnd(sub.startDate, sub.plan);
    if (!periodEnd) {
      return res.status(500).json({ error: 'No se pudo calcular el fin del periodo.' });
    }
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'cancelled', endDate: periodEnd, currentPeriodEnd: periodEnd, gracePeriodEndsAt: periodEnd },
    });
    res.json({ message: 'Suscripción cancelada. Seguirás con acceso hasta el final del periodo actual.' });
  } catch (error) {
    if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
      res.status(503).json({ error: 'Configuración de pagos no disponible. Contacta a soporte.' });
      return;
    }
    next(error);
  }
});

/**
 * POST /billing/cancel-scheduled
 * Cancela una suscripción programada (status='scheduled').
 * Cancela el preapproval en MP y elimina el registro local.
 * Si había una sub cancelled-in-period, el usuario vuelve a poder reactivar.
 */
router.post('/billing/cancel-scheduled', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const scheduledSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'scheduled' },
      orderBy: { startDate: 'desc' },
    });

    if (!scheduledSub) {
      return res.status(400).json({ error: 'No hay suscripción programada para cancelar.' });
    }

    // Cancelar preapproval en MP
    if (scheduledSub.mercadopagoPreapprovalId) {
      try {
        const mercadopagoService = require('../services/mercadopagoService');
        await mercadopagoService.cancelSubscription(scheduledSub.mercadopagoPreapprovalId);
      } catch (err) {
        console.error('[billing/cancel-scheduled] Error cancelando preapproval en MP:', err?.message);
      }
    }

    await prisma.subscription.update({
      where: { id: scheduledSub.id },
      data: { status: 'cancelled', isActiveSubscription: false },
    });

    planService.invalidateCache(organizationId);

    res.json({ message: 'Suscripción programada cancelada.' });
  } catch (error) {
    if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
      return res.status(503).json({ error: 'Configuración de pagos no disponible. Contacta soporte.' });
    }
    next(error);
  }
});

/**
 * POST /billing/reactivate
 * Para usuarios en estado "cancelled" con acceso activo (cancelled-in-period).
 * when='end_of_period' (default): primer cobro al vencer el periodo ya pagado (sin doble cobro).
 * when='now': checkout con inicio de cobro inmediato (nuevo preapproval desde ya).
 * Acepta plan opcional para cambiar de plan al mismo tiempo.
 */
router.post('/billing/reactivate', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const when = req.body?.when === 'now' ? 'now' : 'end_of_period';

    // Buscar sub cancelada con acceso vigente
    const cancelledSub = await prisma.subscription.findFirst({
      where: {
        organizationId,
        status: 'cancelled',
        endDate: { gt: new Date() },
      },
      orderBy: { startDate: 'desc' },
      include: { plan: true },
    });

    if (!cancelledSub?.endDate) {
      return res.status(400).json({ error: 'No hay suscripción cancelada con acceso activo para reactivar.' });
    }

    // Plan: el que se pase en body o el de la sub cancelada
    const planSKU = req.body?.plan?.trim() || cancelledSub.plan?.productSKU;
    if (!planSKU) {
      return res.status(400).json({ error: 'No se pudo determinar el plan.' });
    }

    const plan = await prisma.plan.findUnique({ where: { productSKU: planSKU } });
    if (!plan) return res.status(400).json({ error: `Plan no encontrado: ${planSKU}` });

    if (plan.comingSoon) {
      return res.status(400).json({ error: 'Este plan aún no está disponible. Pronto podrás contratarlo.' });
    }

    if (!(await orgCanUsePlan(organizationId, plan))) {
      return res.status(403).json({ error: 'Este plan no está disponible para tu cuenta.' });
    }

    // Limpiar sesiones pendientes previas para esta organización
    await prisma.checkoutSession.updateMany({
      where: { organizationId, status: 'pending' },
      data: { status: 'expired' },
    });

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        organizationId,
        userId: req.user.id,
        planId: plan.id,
        status: 'pending',
        expiresAt,
        // when=now: marcar como cambio inmediato para que confirmSubscriptionFromPreapproval active en vez de programar
        pendingChangeFromSubscriptionId: when === 'now' ? cancelledSub.id : null,
      },
    });

    const mercadopagoService = require('../services/mercadopagoService');
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const mercadopagoPayerEmail = await persistMercadoPagoPayerEmail(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
    );

    // end_of_period: primer cobro al vencer el periodo ya pagado. now: cobro desde inmediato (createSubscription usa +2 min si no hay fecha futura).
    const createOpts = when === 'end_of_period' ? { startDate: cancelledSub.endDate } : {};
    const result = await mercadopagoService.createSubscription(
      organizationId,
      req.user.id,
      user?.email,
      planSKU,
      restaurantId,
      createOpts
    );

    const checkoutUrl = result?.init_point ?? result?.initPoint ?? null;
    const preapprovalId = result?.id ?? null;

    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: { mercadopagoPreapprovalId: preapprovalId, checkoutUrl },
    });

    sendCheckoutJson(res, checkoutUrl, mercadopagoPayerEmail);
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
});

/**
 * POST /billing/change-plan
 * Cambia de plan desde una suscripción activa.
 *
 * when='now' (default): abre checkout inmediato; la sub actual en MP se mantiene hasta que
 *   el nuevo pago autorice (CheckoutSession.pendingChangeFromSubscriptionId).
 * when='end_of_period': cancela el preapproval de MP (deja de cobrar el plan viejo),
 *   mantiene acceso hasta el fin del periodo ya pagado, y abre un checkout cuyo
 *   primer cobro es en esa fecha (igual que reactivate pero partiendo de un estado activo).
 */
router.post('/billing/change-plan', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const newPlanSKU = req.body?.plan?.trim();
    if (!newPlanSKU) return res.status(400).json({ error: 'plan requerido' });

    const when = req.body?.when === 'end_of_period' ? 'end_of_period' : 'now';

    const newPlan = await prisma.plan.findUnique({ where: { productSKU: newPlanSKU } });
    if (!newPlan) return res.status(400).json({ error: `Plan no encontrado: ${newPlanSKU}` });

    if (newPlan.comingSoon) {
      return res.status(400).json({ error: 'Este plan aún no está disponible. Pronto podrás contratarlo.' });
    }

    if (!(await orgCanUsePlan(organizationId, newPlan))) {
      return res.status(403).json({ error: 'Este plan no está disponible para tu cuenta.' });
    }

    const currentSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'active' },
      orderBy: { startDate: 'desc' },
      include: { plan: true },
    });
    if (!currentSub) {
      return res.status(400).json({ error: 'No tienes una suscripción activa para cambiar.' });
    }
    if (currentSub.plan.productSKU === newPlanSKU) {
      return res.status(400).json({ error: 'Ya tienes este plan activo.' });
    }

    const mercadopagoService = require('../services/mercadopagoService');

    let checkoutStartDateOpt = null;

    if (when === 'end_of_period') {
      const periodEnd = computePeriodEnd(currentSub.startDate, currentSub.plan);
      if (!periodEnd) {
        return res.status(500).json({ error: 'No se pudo calcular el fin del periodo.' });
      }
      checkoutStartDateOpt = periodEnd;
      // No cancelar en MP ni en DB aquí: el plan activo sigue vigente hasta que el usuario
      // complete el pago. Si abandona el checkout, su plan no se ve afectado.
      // La cancelación del preapproval anterior en MP ocurre al confirmar el nuevo
      // (ver cancelReplacedPreapprovalOnSchedule en webhook / confirmSubscriptionFromPreapproval).
    }
    // when === 'now': igual — no cancelar hasta que el nuevo preapproval autorice.

    planService.invalidateCache(organizationId);

    await prisma.checkoutSession.updateMany({
      where: { organizationId, status: 'pending' },
      data: { status: 'expired' },
    });

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        organizationId,
        userId: req.user.id,
        planId: newPlan.id,
        status: 'pending',
        expiresAt,
        // Guardado para ambos modos (now y end_of_period):
        // permite cancelar el preapproval anterior en MP al autorizar el nuevo
        // y reemplazar la sub activa al activar el nuevo plan.
        pendingChangeFromSubscriptionId: currentSub.id,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const mercadopagoPayerEmail = await persistMercadoPagoPayerEmail(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
    );

    const result = await mercadopagoService.createSubscription(
      organizationId,
      req.user.id,
      user?.email,
      newPlanSKU,
      restaurantId,
      checkoutStartDateOpt ? { startDate: checkoutStartDateOpt } : {}
    );

    const checkoutUrl = result?.init_point ?? result?.initPoint ?? null;
    const preapprovalId = result?.id ?? null;

    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: { mercadopagoPreapprovalId: preapprovalId, checkoutUrl },
    });

    sendCheckoutJson(res, checkoutUrl, mercadopagoPayerEmail);
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
});

module.exports = router;
