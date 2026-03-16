const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { getActiveSubscription, hasActiveAccess, isTrialing, getOrganizationWithTrial } = require('../services/subscriptionService');
const planService = require('../services/planService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner', 'restaurant_manager']));

router.get('/subscription', async (req, res, next) => {
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
    const status = trialing ? 'trial' : inGrace ? 'grace' : (sub ? 'active' : 'expired');
    const cancelAtEndDate = sub?.status === 'cancelled' && sub?.endDate ? sub.endDate.toISOString() : null;

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

    res.json({
      plan: plan?.productSKU || 'plan-basico',
      status,
      trialEndsAt: org?.trialEndsAt?.toISOString() ?? null,
      cancelAtEndDate,
      paymentGracePeriod: inGrace,
      gracePeriodEndsAt: sub?.gracePeriodEndsAt?.toISOString() ?? null,
      hasAccess,
      canActivate: !hasAccess || inGrace || trialing,
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
      } : null,
      allPlans: await prisma.plan.findMany({
        where: { isDefault: true },
        orderBy: { productSKU: 'asc' }
      }),
    });
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

    // Find plan
    const plan = await prisma.plan.findUnique({
      where: { productSKU: planSKU },
    });
    if (!plan) throw new Error(`Plan no encontrado: ${planSKU}`);

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

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const appUrl = (process.env.APP_URL || (process.env.CORS_ORIGINS || '').split(',')[0]?.trim() || 'http://localhost:5174').trim();
    const backendPublicUrl = (process.env.BACKEND_PUBLIC_URL || '').trim();
    const backUrl = appUrl.includes('localhost') && backendPublicUrl
      ? `${backendPublicUrl.replace(/\/$/, '')}/api/redirect-to-billing/${restaurantId}`
      : `${appUrl.replace(/\/$/, '')}/billing?restaurantId=${restaurantId}`;

    const result = await mercadopagoService.createSubscription(
      organizationId,
      req.user.id,
      backUrl,
      user?.email,
      planSKU
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

    res.json({ checkoutUrl });
  } catch (error) {
    if (error.message?.includes('MERCADOPAGO_ACCESS_TOKEN')) {
      res.status(503).json({ error: 'Configuración de pagos no disponible. Contacta a soporte.' });
      return;
    }
    if (error.message?.includes('BACKEND_PUBLIC_URL') || error.message?.includes('MP_TEST_PAYER')) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error.message?.includes('MercadoPago') || error.message?.includes('temporalmente no disponible')) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
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
      return res.json({ ok: true, message: 'Suscripción activada' });
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
    if (!sub?.mercadopagoPreapprovalId) {
      res.status(400).json({ error: 'No hay suscripción activa para cancelar.' });
      return;
    }
    const mercadopagoService = require('../services/mercadopagoService');
    await mercadopagoService.cancelSubscription(sub.mercadopagoPreapprovalId);
    
    const config = sub.plan;
    const mpFreq = planService.toMercadoPagoFrequency(config?.billingFrequency ?? 1, config?.billingFrequencyType ?? 'months');
    const billingDays = mpFreq.frequency_type === 'months' ? mpFreq.frequency * 30 : mpFreq.frequency;
    const periodEnd = new Date(Date.now() + billingDays * 24 * 60 * 60 * 1000);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'cancelled', endDate: periodEnd },
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

module.exports = router;
