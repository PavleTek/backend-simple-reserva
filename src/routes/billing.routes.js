const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { getActiveSubscription, hasActiveAccess, isTrialing, getOrganizationWithTrial } = require('../services/subscriptionService');
const planService = require('../services/planService');
const { sortPlansByDisplayOrder } = require('../lib/planDisplayOrder');
const { computePeriodEnd, estimateNextPaymentDate } = require('../lib/billingPeriod');
const { getMercadoPagoCheckoutHints } = require('../services/mercadopagoService');
const {
  tryGrantManualReferralWindowAtCheckout,
} = require('../services/billing/referralFreeWindowService');

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

function sendCheckoutJson(res, checkoutUrl, mercadopagoPayerEmail, checkoutHints) {
  res.json({
    checkoutUrl,
    mercadopagoPayerEmail: mercadopagoPayerEmail || null,
    paymentProvider: checkoutHints?.paymentProvider ?? null,
    checkoutHints: checkoutHints?.hints ?? getMercadoPagoCheckoutHints(mercadopagoPayerEmail),
  });
}

/** Correo para checkout: obligatorio en preapproval; opcional en Checkout Pro. */
async function resolvePayerEmailForCheckout(organizationId, bodyEmail, loginEmail, paymentProvider) {
  const { PAYMENT_PROVIDER_MP_CHECKOUT_PRO } = require('../lib/billingProviders');
  if (paymentProvider === PAYMENT_PROVIDER_MP_CHECKOUT_PRO) {
    const fromBody = (bodyEmail || '').trim();
    if (fromBody && isValidPayerEmail(fromBody)) {
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
    return null;
  }
  return persistMercadoPagoPayerEmail(organizationId, bodyEmail, loginEmail);
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
const { orgCanUsePlan } = require('../lib/orgPlanAccess');

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
  const { PAYMENT_PROVIDER_MP_CHECKOUT_PRO } = require('../lib/billingProviders');
  if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
    res.status(503).json({ error: 'Configuración de pagos no disponible. Contacta a soporte.' });
    return;
  }
  if (error.mpPolicyBlocked) {
    res.status(502).json({
      error: 'checkout_mp_policy_blocked',
      message:
        'Mercado Pago rechazó crear la suscripción. Revisa que tu aplicación en developers.mercadopago.cl tenga Suscripciones activo.',
      alternatePaymentProvider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
    });
    return;
  }
  if (error.mpPayerCountryMismatch) {
    res.status(400).json({
      error: 'checkout_mp_payer_country',
      message: error.message,
      alternatePaymentProvider: PAYMENT_PROVIDER_MP_CHECKOUT_PRO,
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

router.get('/billing/providers', authenticateRestaurantRoles(ROLES_BILLING), async (req, res) => {
  const {
    listBillingProvidersForApi,
    listCollectionMethodsForApi,
    getDefaultPaymentProvider,
    getDefaultBillingStrategy,
  } = require('../lib/billingProviders');
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: req.activeRestaurant.restaurantId },
    select: { organizationId: true },
  });
  const org = restaurant
    ? await prisma.restaurantOrganization.findUnique({
        where: { id: restaurant.organizationId },
        select: { billingCountry: true, owner: { select: { country: true } } },
      })
    : null;
  const collectionMethods = listCollectionMethodsForApi(org);
  res.json({
    providers: listBillingProvidersForApi(org),
    collectionMethods,
    defaultProvider: getDefaultPaymentProvider(org),
    defaultBillingStrategy: getDefaultBillingStrategy(org),
    billingCountry: org?.billingCountry ?? org?.owner?.country ?? 'CL',
  });
});

router.get('/billing/collection-methods', authenticateRestaurantRoles(ROLES_BILLING), async (req, res) => {
  const { listCollectionMethodsForApi, getDefaultBillingStrategy } = require('../lib/billingProviders');
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: req.activeRestaurant.restaurantId },
    select: { organizationId: true },
  });
  const org = restaurant
    ? await prisma.restaurantOrganization.findUnique({
        where: { id: restaurant.organizationId },
        select: { billingCountry: true, owner: { select: { country: true } } },
      })
    : null;
  res.json({
    collectionMethods: listCollectionMethodsForApi(org),
    defaultBillingStrategy: getDefaultBillingStrategy(org),
    billingCountry: org?.billingCountry ?? org?.owner?.country ?? 'CL',
  });
});

/** Logos oficiales MP (marca + medios de pago vía API /v1/payment_methods). */
router.get('/billing/payment-assets', authenticateRestaurantRoles(ROLES_BILLING), async (req, res, next) => {
  try {
    const mercadopagoPaymentMethodsService = require('../services/mercadopagoPaymentMethodsService');
    const assets = await mercadopagoPaymentMethodsService.getPaymentMethodAssets();
    res.json(assets);
  } catch (error) {
    if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
      return res.status(503).json({ error: 'Configuración de pagos no disponible.' });
    }
    next(error);
  }
});

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

    // Planes disponibles: públicos + CustomPlanOffer (+ legacy customPlanId si aún no migrado)
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
    const legacyCustomPlan = orgWithCustomPlan?.customPlan ?? null;

    let allPlansForOrg = [...publicPlans];
    const allPlanIds = new Set(allPlansForOrg.map((p) => p.id));
    for (const offer of planOffers) {
      if (offer.plan && !allPlanIds.has(offer.plan.id)) {
        allPlansForOrg.push(offer.plan);
        allPlanIds.add(offer.plan.id);
      }
    }
    if (legacyCustomPlan && !allPlanIds.has(legacyCustomPlan.id)) {
      allPlansForOrg = [...allPlansForOrg, legacyCustomPlan];
      allPlanIds.add(legacyCustomPlan.id);
    }

    const offeredPlans = sortPlansByDisplayOrder(
      planOffers.map((o) => o.plan).filter((p) => p && !publicPlans.some((pub) => pub.id === p.id))
    );
    const customPlan = planOffers[0]?.plan ?? legacyCustomPlan;

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

    const { subscriptionBillingView } = require('../lib/billingDomain');
    const {
      buildPendingChange,
      buildBillingCapabilities,
      buildEntitlementBlock,
    } = require('../services/billing/billingContractService');

    const pendingChange = await buildPendingChange({
      sub,
      scheduledSub,
      renewalScheduledSamePlan,
    });

    let scheduledPlanOut =
      pendingChange?.type === 'plan_change_scheduled' ? pendingChange.planSku : null;
    let scheduledPlanNameOut =
      pendingChange?.type === 'plan_change_scheduled' ? pendingChange.planName : null;
    let scheduledDateOut =
      pendingChange?.type === 'plan_change_scheduled' || pendingChange?.type === 'renewal_scheduled'
        ? pendingChange.effectiveAt
        : null;
    if (renewalScheduledSamePlan && scheduledSub) {
      scheduledPlanOut = null;
      scheduledPlanNameOut = null;
      scheduledDateOut = scheduledSub.startDate?.toISOString() ?? null;
    }

    const billingView = sub ? subscriptionBillingView(sub) : null;
    const capabilities = await buildBillingCapabilities({
      organizationId,
      sub,
      scheduledSub,
      status,
      plan,
    });
    const entitlement = await buildEntitlementBlock(organizationId, sub, plan);

    const canReactivate = capabilities.canReactivate;

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
      organizationName: orgWithCustomPlan?.name ?? null,
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
      paymentProvider: billingView?.paymentProvider ?? sub?.paymentProvider ?? null,
      billingStrategy: billingView?.billingStrategy ?? null,
      collectionMethodLabel: billingView?.collectionMethodLabel ?? null,
      legacyPaymentProviderId: billingView?.legacyPaymentProviderId ?? null,
      scheduledChangeSource: pendingChange?.source ?? null,
      pendingChange,
      capabilities,
      entitlement,
      billing: billingView
        ? {
            strategy: billingView.billingStrategy,
            strategyLabel: billingView.collectionMethodLabel,
            paymentProvider: billingView.paymentProvider,
          }
        : null,
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

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [receipts, total] = await Promise.all([
      prisma.paymentReceipt.findMany({
        where: { organizationId: restaurant.organizationId },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: limit,
        include: { plan: { select: { name: true } } },
      }),
      prisma.paymentReceipt.count({ where: { organizationId: restaurant.organizationId } }),
    ]);

    const payments = receipts.map((r) => ({
      id: r.id,
      paymentDate: r.paymentDate.toISOString(),
      amount: Number(r.amount),
      currency: r.currency,
      status: r.mercadopagoStatus ?? 'unknown',
      planName: r.plan?.name ?? '—',
      receiptType: r.receiptType,
    }));

    res.json({ payments, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
});

router.get('/billing/overview', authenticateRestaurantRoles(ROLES_BILLING), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const { getBillingOverview } = require('../services/billing/billingOverviewService');
    const overview = await getBillingOverview(restaurant.organizationId, restaurantId);
    res.json(overview);
  } catch (error) {
    next(error);
  }
});

router.post('/billing/change-plan/preview', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.activeRestaurant.restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const planSKU = String(req.body?.plan ?? req.body?.planSKU ?? '').trim();
    if (!planSKU) {
      return res.status(400).json({ error: 'plan requerido' });
    }
    const { previewChangePlan } = require('../services/billing/changePlanPreviewService');
    const { normalizePlanChangeWhen } = require('../lib/billingDomain');
    const result = await previewChangePlan({
      organizationId: restaurant.organizationId,
      planSKU,
      when: req.body?.when ? normalizePlanChangeWhen(req.body.when) : undefined,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/billing/recovery/create-link', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const { createRecoveryPaymentLink } = require('../services/billing/recoveryLinkService');
    const result = await createRecoveryPaymentLink({
      organizationId: restaurant.organizationId,
      userId: req.user.id,
      restaurantId,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
});

async function handleCollectionMethodUpdate(req, res, next) {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const org = await prisma.restaurantOrganization.findUnique({
      where: { id: restaurant.organizationId },
      select: { billingCountry: true, owner: { select: { country: true } } },
    });
    const { normalizeBillingInput } = require('../lib/billingProviders');
    const { updateCollectionMethod } = require('../services/billing/billingOrchestrator');
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
    const billing = normalizeBillingInput(req.body, org);
    const paymentProvider = billing.legacyPaymentProviderId;
    const mercadopagoPayerEmail = await resolvePayerEmailForCheckout(
      restaurant.organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
      paymentProvider,
    );
    const sub = await getActiveSubscription(restaurant.organizationId);
    const { canSelfServeBillingOrThrow } = require('../lib/canSelfServeBilling');
    canSelfServeBillingOrThrow(sub);
    if (!sub || sub.status !== 'active') {
      return res.status(400).json({ error: 'Activa un plan de pago antes de cambiar el método de cobro.' });
    }
    const planSku = sub?.plan?.productSKU || 'plan-profesional';

    const result = await updateCollectionMethod({
      organizationId: restaurant.organizationId,
      userId: req.user.id,
      payerEmail: mercadopagoPayerEmail,
      planSKU: planSku,
      restaurantId,
      billingStrategy: billing.billingStrategy,
      paymentProviderPsp: billing.paymentProvider,
    });

    if (result.updated && !result.checkoutUrl) {
      planService.invalidateCache(restaurant.organizationId);
      return res.json({
        updated: true,
        requiresCheckout: false,
        message: result.message,
        billingStrategy: result.billingStrategy,
        collectionMethodLabel: require('../lib/billingDomain').collectionMethodLabel(
          result.billingStrategy,
        ),
      });
    }

    sendCheckoutJson(res, result.checkoutUrl, mercadopagoPayerEmail, {
      paymentProvider: result.providerId,
      billingStrategy: billing.billingStrategy,
      hints: result.checkoutHints,
    });
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
}

router.post('/billing/payment-method/update', authenticateRestaurantRoles(['restaurant_owner']), handleCollectionMethodUpdate);
router.post('/billing/collection-method/update', authenticateRestaurantRoles(['restaurant_owner']), handleCollectionMethodUpdate);

router.get('/billing/invoices/:invoiceId/pdf', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.activeRestaurant.restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');

    const receipt = await prisma.paymentReceipt.findFirst({
      where: { id: req.params.invoiceId, organizationId: restaurant.organizationId },
      include: { plan: true, organization: true },
    });
    if (!receipt) return res.status(404).json({ error: 'Recibo no encontrado' });

    const format = (req.query.format || 'pdf').toString();
    const { generateReceiptPdf, generateReceiptHtml } = require('../services/billing/receiptPdfGenerator');

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(generateReceiptHtml(receipt, receipt.organization, receipt.plan));
    }

    const pdf = await generateReceiptPdf(receipt, receipt.organization, receipt.plan);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="recibo-${receipt.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

router.post('/billing/cancel/analytics', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.activeRestaurant.restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');

    await prisma.subscriptionCancellation.create({
      data: {
        organizationId: restaurant.organizationId,
        reason: req.body?.reason || null,
        reasonDetail: req.body?.reasonDetail || null,
        offeredDowngrade: !!req.body?.offeredDowngrade,
        acceptedRetention: !!req.body?.acceptedRetention,
      },
    });
    res.json({ ok: true });
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
    if (req.body?.when === 'end_of_trial') {
      return res.status(400).json({
        error: 'La activación en periodo de prueba es inmediata. Elige activar ahora.',
      });
    }
    const when = 'now';

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

    const billingCheckoutService = require('../services/billingCheckoutService');
    const { isTrialing } = require('../services/subscriptionService');
    const { normalizePaymentProvider } = require('../lib/billingProviders');

    const paymentProvider = normalizePaymentProvider(req.body?.paymentProvider);

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

    const manualGrant = await tryGrantManualReferralWindowAtCheckout({
      organizationId,
      planSKU,
      paymentProvider,
    });
    if (manualGrant) {
      planService.invalidateCache(organizationId);
      return res.json({
        referralFreeWindowGranted: true,
        freeUntil: manualGrant.freeUntil.toISOString(),
        totalDays: manualGrant.totalDays,
        message: manualGrant.message,
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const mercadopagoPayerEmail = await resolvePayerEmailForCheckout(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
      paymentProvider,
    );

    const result = await billingCheckoutService.createBillingCheckout({
      organizationId,
      userId: req.user.id,
      payerEmail: mercadopagoPayerEmail || user?.email,
      planSKU,
      restaurantId,
      when,
      paymentProvider,
      createSubscriptionOptions,
    });

    sendCheckoutJson(res, result.checkoutUrl, mercadopagoPayerEmail, {
      paymentProvider: result.providerId,
      hints: result.checkoutHints,
    });
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

/** Fallback cuando el webhook de Checkout Pro no llega: confirma por payment_id del retorno MP. */
router.post('/billing/confirm-payment', authenticateRestaurantRoles(['restaurant_owner']), async (req, res, next) => {
  try {
    const restaurantId = req.activeRestaurant.restaurantId;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) throw new Error('Restaurante no encontrado');
    const organizationId = restaurant.organizationId;

    const paymentId = req.body?.paymentId?.trim();
    if (!paymentId) {
      return res.status(400).json({ error: 'paymentId requerido' });
    }

    const mercadopagoCheckoutProService = require('../services/mercadopagoCheckoutProService');
    const result = await mercadopagoCheckoutProService.confirmPaymentFromMercadoPago(organizationId, paymentId);
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      res.status(400).json({ error: error.message });
      return;
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

    if (req.body?.reason || req.body?.reasonDetail) {
      await prisma.subscriptionCancellation.create({
        data: {
          organizationId,
          subscriptionId: sub.id,
          reason: req.body.reason || null,
          reasonDetail: req.body.reasonDetail || null,
          offeredDowngrade: !!req.body.offeredDowngrade,
          acceptedRetention: !!req.body.acceptedRetention,
        },
      });
    }

    try {
      const { sendSubscriptionCancelledEmail } = require('../services/billing/billingTransactionalEmailService');
      await sendSubscriptionCancelledEmail({ organizationId, endDate: periodEnd });
    } catch (emailErr) {
      console.error('[billing/cancel] email error:', emailErr?.message);
    }

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
 * Cancela un cambio programado: campos DB en sub activa (manual EOP) o fila MP status=scheduled.
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

    const { cancelPendingScheduledChange } = require('../services/billing/billingOrchestrator');
    const result = await cancelPendingScheduledChange(organizationId);

    if (!result) {
      return res.status(400).json({ error: 'No hay cambio programado para cancelar.' });
    }

    res.json({ message: result.message, kind: result.kind });
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

    const whenRaw = String(req.body?.when || '').trim();
    const when = whenRaw === 'now' || whenRaw === 'immediate' ? 'now' : 'end_of_period';

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

    await prisma.checkoutSession.updateMany({
      where: { organizationId, status: 'pending' },
      data: { status: 'expired' },
    });

    const billingCheckoutService = require('../services/billingCheckoutService');
    const { normalizePaymentProvider, PAYMENT_PROVIDER_MP_CHECKOUT_PRO } = require('../lib/billingProviders');
    const {
      resolveBillingStrategy,
      BILLING_STRATEGY_AUTOMATIC,
      BILLING_STRATEGY_MANUAL,
    } = require('../lib/billingDomain');
    const strategy = resolveBillingStrategy(cancelledSub);
    const defaultProvider =
      strategy === BILLING_STRATEGY_MANUAL
        ? PAYMENT_PROVIDER_MP_CHECKOUT_PRO
        : 'mercadopago_preapproval';
    const paymentProvider = req.body?.paymentProvider
      ? normalizePaymentProvider(req.body.paymentProvider)
      : defaultProvider;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const mercadopagoPayerEmail = await resolvePayerEmailForCheckout(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
      paymentProvider,
    );

    const createOpts = when === 'end_of_period' ? { startDate: cancelledSub.endDate } : {};

    if (when === 'now') {
      const manualGrant = await tryGrantManualReferralWindowAtCheckout({
        organizationId,
        planSKU,
        paymentProvider,
        replaceSubscriptionId: cancelledSub.id,
      });
      if (manualGrant) {
        planService.invalidateCache(organizationId);
        return res.json({
          reactivated: true,
          referralFreeWindowGranted: true,
          freeUntil: manualGrant.freeUntil.toISOString(),
          totalDays: manualGrant.totalDays,
          message: manualGrant.message,
        });
      }
    }

    let result;
    if (when === 'end_of_period' && strategy === BILLING_STRATEGY_MANUAL) {
      await prisma.subscription.update({
        where: { id: cancelledSub.id },
        data: {
          status: 'active',
          endDate: null,
          gracePeriodEndsAt: null,
          isActiveSubscription: true,
        },
      });
      planService.invalidateCache(organizationId);
      return res.json({
        reactivated: true,
        scheduled: false,
        message:
          'Tu suscripción con pago mensual manual quedó reactivada. Te enviaremos el link de cobro al renovar el periodo.',
      });
    }
    if (when === 'now') {
      result = await billingCheckoutService.createBillingCheckoutWithPendingChange({
        organizationId,
        userId: req.user.id,
        payerEmail: mercadopagoPayerEmail || user?.email,
        planSKU,
        restaurantId,
        when: 'now',
        paymentProvider,
        pendingChangeFromSubscriptionId: cancelledSub.id,
        createSubscriptionOptions: createOpts,
      });
    } else {
      result = await billingCheckoutService.createBillingCheckout({
        organizationId,
        userId: req.user.id,
        payerEmail: mercadopagoPayerEmail || user?.email,
        planSKU,
        restaurantId,
        when: 'end_of_period',
        paymentProvider:
          strategy === BILLING_STRATEGY_MANUAL ? PAYMENT_PROVIDER_MP_CHECKOUT_PRO : 'mercadopago_preapproval',
        createSubscriptionOptions: createOpts,
      });
    }

    sendCheckoutJson(res, result.checkoutUrl, mercadopagoPayerEmail, {
      paymentProvider: result.providerId,
      hints: result.checkoutHints,
    });
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
});

/**
 * POST /billing/change-plan
 * when: immediate | end_of_period — independiente del método de cobro.
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

    const { normalizePlanChangeWhen } = require('../lib/billingDomain');
    const { executePlanChange } = require('../services/billing/billingOrchestrator');
    const when = normalizePlanChangeWhen(req.body?.when || 'end_of_period');

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const activeSub = await prisma.subscription.findFirst({
      where: { organizationId, status: 'active' },
      include: { plan: true },
    });
    const { resolveBillingStrategy, BILLING_STRATEGY_AUTOMATIC } = require('../lib/billingDomain');
    const strategy = activeSub ? resolveBillingStrategy(activeSub) : BILLING_STRATEGY_AUTOMATIC;
    const legacyProvider =
      strategy === BILLING_STRATEGY_AUTOMATIC ? 'mercadopago_preapproval' : 'mp_checkout_pro';

    const mercadopagoPayerEmail = await resolvePayerEmailForCheckout(
      organizationId,
      req.body?.mercadopagoPayerEmail,
      user?.email,
      legacyProvider,
    );

    const result = await executePlanChange({
      organizationId,
      userId: req.user.id,
      payerEmail: mercadopagoPayerEmail || user?.email,
      planSKU: newPlanSKU,
      restaurantId,
      when,
      body: req.body,
    });

    if (result.scheduled) {
      return res.json({
        scheduled: true,
        effectiveDate: result.effectiveDate,
        scheduledPlan: result.scheduledPlanSku,
        scheduledPlanName: result.scheduledPlanName,
        message: `Cambio al plan ${result.scheduledPlanName} programado para el ${result.effectiveDate.slice(0, 10)}.`,
      });
    }

    if (result.planChanged) {
      return res.json({
        planChanged: true,
        referralFreeUntil: result.referralFreeUntil,
        message: result.message,
      });
    }

    sendCheckoutJson(res, result.checkoutUrl, mercadopagoPayerEmail, {
      paymentProvider: result.providerId,
      billingStrategy: result.billingStrategy,
      hints: result.checkoutHints,
    });
  } catch (error) {
    handleBillingRouteError(error, res, next, respondMercadoPagoCheckoutError);
  }
});

module.exports = router;
