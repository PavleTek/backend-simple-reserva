const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const mercadopagoService = require('../src/services/mercadopagoService');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting comprehensive database seeding...');

  const summary = {
    Plan: { created: 0, skipped: 0 },
    EmailSender: { created: 0, skipped: 0 },
    Configuration: { created: 0, skipped: 0 },
    User: { created: 0, skipped: 0 },
    RestaurantOrganization: { created: 0, skipped: 0 },
    Restaurant: { created: 0, skipped: 0 },
    OrganizationManager: { created: 0, skipped: 0 },
    ManagerRestaurantAssignment: { created: 0, skipped: 0 },
    Zone: { created: 0, skipped: 0 },
    RestaurantTable: { created: 0, skipped: 0 },
    Schedule: { created: 0, skipped: 0 },
    BlockedSlot: { created: 0, skipped: 0 },
    Reservation: { created: 0, skipped: 0 },
    Subscription: { created: 0, skipped: 0 },
  };

  // 0. Seed Plan (basico, profesional, premium)
  const plans = [
    {
      productSKU: 'plan-basico',
      name: 'Básico',
      description: '1 local, ideal para empezar',
      isDefault: true,
      maxRestaurants: 1,
      maxZonesPerRestaurant: 3,
      maxTables: 15,
      maxTeamMembers: 2,
      whatsappFeatures: false,
      googleReserveIntegration: false,
      multipleMenu: false,
      priceCLP: 9990,
      priceUSD: 12.99,
      priceEUR: 11.49,
      prioritySupport: false,
      billingFrequency: 1,
      billingFrequencyType: 'months',
      freeTrialLength: 1,
      freeTrialLengthUnit: 'months',
    },
    {
      productSKU: 'plan-profesional',
      name: 'Profesional',
      description: 'Para quienes tienen más de un local (hasta 3 sedes)',
      isDefault: true,
      maxRestaurants: 3,
      maxZonesPerRestaurant: null,
      maxTables: null,
      maxTeamMembers: 5,
      whatsappFeatures: false,
      googleReserveIntegration: true,
      multipleMenu: true,
      priceCLP: 14990,
      priceUSD: 18.99,
      priceEUR: 16.99,
      prioritySupport: false,
      billingFrequency: 1,
      billingFrequencyType: 'months',
    },
    {
      productSKU: 'plan-premium',
      name: 'Premium',
      description: 'Hasta 20 locales para cadenas',
      isDefault: true,
      maxRestaurants: 20,
      maxZonesPerRestaurant: null,
      maxTables: null,
      maxTeamMembers: null,
      whatsappFeatures: true,
      googleReserveIntegration: true,
      multipleMenu: true,
      priceCLP: 39990,
      priceUSD: 44.99,
      priceEUR: 41.99,
      prioritySupport: true,
      billingFrequency: 1,
      billingFrequencyType: 'months',
    },
  ];
  
  const planMap = {};
  for (const data of plans) {
    const p = await prisma.plan.upsert({
      where: { productSKU: data.productSKU },
      create: data,
      update: data,
    });
    planMap[data.productSKU] = p;
    summary.Plan.created += 1;
  }

  // 0.1 Sync Plans to MercadoPago
  console.log('🔄 Syncing plans to MercadoPago...');
  if (process.env.MERCADOPAGO_ACCESS_TOKEN) {
    for (const sku in planMap) {
      try {
        const plan = planMap[sku];
        await mercadopagoService.syncPlanToMercadoPago(plan.id);
        console.log(`✅ Synced plan ${sku} to MercadoPago`);
      } catch (err) {
        console.error(`❌ Failed to sync plan ${sku} to MercadoPago:`, err.message);
      }
    }
  } else {
    console.log('⚠️ Skipping MercadoPago sync: MERCADOPAGO_ACCESS_TOKEN not set');
  }

  // 1. Seed EmailSender
  const emailSender = await prisma.emailSender.upsert({
    where: { email: 'noreply@simplereserva.com' },
    create: { email: 'noreply@simplereserva.com' },
    update: {},
  });
  summary.EmailSender.created = 1;

  // 2. Seed Configuration
  await prisma.configuration.upsert({
    where: { id: 'default-config' },
    create: {
      id: 'default-config',
      twoFactorEnabled: false,
      appName: 'SimpleReserva',
      recoveryEmailSenderId: emailSender.id,
      dashboardPollingIntervalSeconds: 30,
    },
    update: {
      recoveryEmailSenderId: emailSender.id,
    }
  });
  summary.Configuration.created = 1;

  // 3. Seed Users & Organizations
  const seedPassword = 'asdf';
  const passwordHash = await bcrypt.hash(seedPassword, 12);

  const superAdmins = [
    { email: 'admin@simplereserva.com', name: 'Super', lastName: 'Admin', role: 'super_admin' },
    { email: 'pavle@simplereserva.com', name: 'Pavle', lastName: 'Admin', role: 'super_admin' },
    { email: 'adminP', name: 'Admin', lastName: 'Platform', role: 'super_admin' }, // From test-setup
  ];

  for (const u of superAdmins) {
    await prisma.user.upsert({
      where: { email: u.email },
      create: { ...u, hashedPassword: passwordHash },
      update: { role: u.role },
    });
    summary.User.created += 1;
  }

  const owners = [
    { email: 'carlos@lacasona.cl', name: 'Carlos', lastName: 'Rodriguez', role: 'restaurant_owner', orgName: 'La Casona Group' },
    { email: 'maria@elporton.cl', name: 'Maria', lastName: 'Gomez', role: 'restaurant_owner', orgName: 'El Porton Enterprises' },
    { email: 'diego@sushiwave.cl', name: 'Diego', lastName: 'Perez', role: 'restaurant_owner', orgName: 'Sushi Wave Nikkei' },
    { email: 'ownerP', name: 'Owner', lastName: 'Platform', role: 'restaurant_owner', orgName: 'Platform Test Group' }, // From test-setup
  ];

  const orgs = [];
  for (const o of owners) {
    const user = await prisma.user.upsert({
      where: { email: o.email },
      create: { 
        email: o.email, 
        name: o.name, 
        lastName: o.lastName, 
        role: o.role, 
        hashedPassword: passwordHash 
      },
      update: { role: o.role },
    });
    summary.User.created += 1;

    const org = await prisma.restaurantOrganization.upsert({
      where: { ownerId: user.id },
      create: {
        name: o.orgName,
        ownerId: user.id,
        planId: planMap['plan-profesional'].id,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
      update: { name: o.orgName },
    });
    orgs.push(org);
    summary.RestaurantOrganization.created += 1;

    // Use upsert or check for existing subscription to avoid duplicates
    const existingSub = await prisma.subscription.findFirst({
      where: { organizationId: org.id, status: 'trial' }
    });
    if (!existingSub) {
      await prisma.subscription.create({
        data: {
          organizationId: org.id,
          planId: planMap['plan-profesional'].id,
          status: 'trial',
        }
      });
      summary.Subscription.created += 1;
    }
  }

  // 4. Seed Restaurants
  const restaurantData = [
    {
      organizationId: orgs[0].id,
      slug: 'la-casona-de-pedro',
      name: 'La Casona de Pedro',
      description: 'Tradición chilena en el corazón de Santiago.',
      address: 'Av. Vitacura 1234, Vitacura, Santiago',
      phone: '+56 2 2234 5678',
      email: 'contacto@lacasona.cl',
      defaultSlotDurationMinutes: 60,
    },
    {
      organizationId: orgs[1].id,
      slug: 'el-porton-rojo',
      name: 'El Porton Rojo',
      description: 'Cocina de autor con vista al mar.',
      address: 'Cerro Alegre, Calle Templeman 567, Valparaíso',
      phone: '+56 32 2234 8901',
      email: 'info@elporton.cl',
      defaultSlotDurationMinutes: 90,
    },
    {
      organizationId: orgs[2].id,
      slug: 'sushi-wave',
      name: 'Sushi Wave',
      description: 'Fusión nikkei con los mejores ingredientes.',
      address: 'Av. San Martín 890, Viña del Mar',
      phone: '+56 32 2256 7890',
      email: 'hola@sushiwave.cl',
      defaultSlotDurationMinutes: 45,
    }
  ];

  const restaurants = [];
  for (const data of restaurantData) {
    const r = await prisma.restaurant.upsert({
      where: { slug: data.slug },
      create: data,
      update: data,
    });
    restaurants.push(r);
    summary.Restaurant.created += 1;
  }

  // 5. Seed Managers
  const managers = [
    { email: 'ana@lacasona.cl', name: 'Ana', lastName: 'Soto', role: 'restaurant_manager', orgId: orgs[0].id, restaurantSlugs: ['la-casona-de-pedro'] },
    { email: 'jose@elporton.cl', name: 'Jose', lastName: 'Muñoz', role: 'restaurant_manager', orgId: orgs[1].id, restaurantSlugs: ['el-porton-rojo'] },
    { email: 'staff@test.com', name: 'Staff', lastName: 'Platform', role: 'restaurant_manager', orgId: orgs[3].id, restaurantSlugs: ['la-casona-de-pedro'] }, // From test-setup, assigned to La Casona
  ];

  for (const m of managers) {
    const user = await prisma.user.upsert({
      where: { email: m.email },
      create: { 
        email: m.email, 
        name: m.name, 
        lastName: m.lastName, 
        role: m.role, 
        hashedPassword: passwordHash 
      },
      update: { role: m.role },
    });
    summary.User.created += 1;

    const orgManager = await prisma.organizationManager.upsert({
      where: { organizationId_userId: { organizationId: m.orgId, userId: user.id } },
      create: { organizationId: m.orgId, userId: user.id },
      update: {},
    });
    summary.OrganizationManager.created += 1;

    for (const slug of m.restaurantSlugs) {
      const rest = restaurants.find(r => r.slug === slug);
      if (rest) {
        await prisma.managerRestaurantAssignment.upsert({
          where: { organizationManagerId_restaurantId: { organizationManagerId: orgManager.id, restaurantId: rest.id } },
          create: { organizationManagerId: orgManager.id, restaurantId: rest.id },
          update: {},
        });
        summary.ManagerRestaurantAssignment.created += 1;
      }
    }
  }

  // 6. Seed Zones, Tables, Schedules, etc.
  for (const rest of restaurants) {
    // Check for existing zones to avoid duplicates
    const zoneNames = rest.slug === 'la-casona-de-pedro' ? ['Salón Principal', 'Terraza'] : ['Salón Principal'];
    
    for (const zoneName of zoneNames) {
      let zone = await prisma.zone.findFirst({
        where: { restaurantId: rest.id, name: zoneName }
      });
      if (!zone) {
        zone = await prisma.zone.create({
          data: { restaurantId: rest.id, name: zoneName, sortOrder: zoneName === 'Terraza' ? 1 : 0 }
        });
        summary.Zone.created += 1;
      }

      // Add tables based on zone
      const tablesToAdd = [];
      if (zoneName === 'Salón Principal') {
        tablesToAdd.push({ label: 'M1', minCapacity: 2, maxCapacity: 4 });
      } else if (zoneName === 'Terraza') {
        tablesToAdd.push(
          { label: 'T1', minCapacity: 2, maxCapacity: 4 },
          { label: 'T2', minCapacity: 2, maxCapacity: 4 },
          { label: 'T3', minCapacity: 4, maxCapacity: 6 },
          { label: 'T4', minCapacity: 4, maxCapacity: 6 },
          { label: 'T5', minCapacity: 6, maxCapacity: 10 }
        );
      }

      for (const t of tablesToAdd) {
        const existingTable = await prisma.restaurantTable.findFirst({
          where: { zoneId: zone.id, label: t.label }
        });
        if (!existingTable) {
          await prisma.restaurantTable.create({
            data: { zoneId: zone.id, ...t }
          });
          summary.RestaurantTable.created += 1;
        }
      }
    }

    for (let i = 0; i < 7; i++) {
      await prisma.schedule.upsert({
        where: {
          restaurantId_dayOfWeek: {
            restaurantId: rest.id,
            dayOfWeek: i,
          }
        },
        create: {
          restaurantId: rest.id,
          dayOfWeek: i,
          openTime: '12:00',
          closeTime: '23:00',
          isActive: true,
        },
        update: {
          openTime: '12:00',
          closeTime: '23:00',
          isActive: true,
        }
      });
      summary.Schedule.created += 1;
    }
  }

  console.log('\n📊 Seeding Summary:');
  console.table(summary);
  console.log('\n🎉 Database seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
