require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting Cypress seed (idempotent)...');

  // ─── Ensure plan-basico exists ────────────────────────────────────────────
  const basicoPlan = await prisma.plan.upsert({
    where: { productSKU: 'plan-basico' },
    create: {
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
      freeTrialLength: 0,
      freeTrialLengthUnit: 'months',
    },
    update: {},
  });
  console.log('  plan-basico: ok');

  // ─── Ensure EmailSender exists ────────────────────────────────────────────
  const emailSender = await prisma.emailSender.upsert({
    where: { email: 'noreply@simplereserva.com' },
    create: { email: 'noreply@simplereserva.com' },
    update: {},
  });

  // ─── Ensure Configuration exists ─────────────────────────────────────────
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
    },
  });
  console.log('  configuration: ok');

  // ─── Cypress password (must match prisma/seed.js dev convention: asdf) ─────
  const password = 'asdf';
  const passwordHash = await bcrypt.hash(password, 12);

  // ─── Cypress restaurant owner ─────────────────────────────────────────────
  const ownerUser = await prisma.user.upsert({
    where: { email: 'cypressRestaurantOwner@test.com' },
    create: {
      email: 'cypressRestaurantOwner@test.com',
      name: 'Cypress',
      lastName: 'Owner',
      role: 'restaurant_owner',
      hashedPassword: passwordHash,
    },
    update: { role: 'restaurant_owner', hashedPassword: passwordHash },
  });
  console.log('  owner: cypressRestaurantOwner@test.com');

  // ─── Organization ─────────────────────────────────────────────────────────
  const org = await prisma.restaurantOrganization.upsert({
    where: { ownerId: ownerUser.id },
    create: {
      name: 'Cypress Test Org',
      ownerId: ownerUser.id,
      planId: basicoPlan.id,
      trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    update: { name: 'Cypress Test Org' },
  });

  // ─── Subscription ─────────────────────────────────────────────────────────
  const existingSub = await prisma.subscription.findFirst({
    where: { organizationId: org.id },
  });
  if (!existingSub) {
    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: basicoPlan.id,
        status: 'trial',
      },
    });
  }
  console.log('  org + subscription: Cypress Test Org');

  // ─── Restaurant ───────────────────────────────────────────────────────────
  const restaurant = await prisma.restaurant.upsert({
    where: { slug: 'cypress-test-restaurant' },
    create: {
      organizationId: org.id,
      slug: 'cypress-test-restaurant',
      name: 'Cypress Test Restaurant',
      description: 'Restaurante para pruebas Cypress E2E.',
      address: 'Calle Cypress 123, Santiago',
      googlePlaceId: 'ChIJdd4hrwug2EcRmSrV3Vo6llI',
      latitude: -33.4569,
      longitude: -70.6483,
      phone: '+56 2 2234 9999',
      email: 'cypress@test.com',
      defaultSlotDurationMinutes: 60,
    },
    update: {
      organizationId: org.id,
      name: 'Cypress Test Restaurant',
    },
  });
  console.log('  restaurant: cypress-test-restaurant');

  // ─── Zone ─────────────────────────────────────────────────────────────────
  let zone = await prisma.zone.findFirst({
    where: { restaurantId: restaurant.id, name: 'Salon Cypress' },
  });
  if (!zone) {
    zone = await prisma.zone.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Salon Cypress',
        sortOrder: 0,
      },
    });
  }

  // ─── Tables ───────────────────────────────────────────────────────────────
  for (const tableData of [
    { label: 'CY-1', minCapacity: 2, maxCapacity: 4, sortOrder: 0 },
    { label: 'CY-2', minCapacity: 2, maxCapacity: 6, sortOrder: 1 },
  ]) {
    const existing = await prisma.restaurantTable.findFirst({
      where: { zoneId: zone.id, label: tableData.label },
    });
    if (!existing) {
      await prisma.restaurantTable.create({
        data: { zoneId: zone.id, ...tableData },
      });
    }
  }
  console.log('  zone + tables: Salon Cypress (CY-1, CY-2)');

  // ─── Schedule (7-day, 12:00-23:00) ───────────────────────────────────────
  for (let day = 0; day < 7; day++) {
    await prisma.schedule.upsert({
      where: {
        restaurantId_dayOfWeek: {
          restaurantId: restaurant.id,
          dayOfWeek: day,
        },
      },
      create: {
        restaurantId: restaurant.id,
        dayOfWeek: day,
        openTime: '12:00',
        closeTime: '23:00',
        isActive: true,
      },
      update: {
        openTime: '12:00',
        closeTime: '23:00',
        isActive: true,
      },
    });
  }
  console.log('  schedules: Mon-Sun 12:00-23:00');

  // ─── Cypress manager ──────────────────────────────────────────────────────
  const managerUser = await prisma.user.upsert({
    where: { email: 'cypressManager@test.com' },
    create: {
      email: 'cypressManager@test.com',
      name: 'Cypress',
      lastName: 'Manager',
      role: 'restaurant_manager',
      hashedPassword: passwordHash,
    },
    update: { role: 'restaurant_manager', hashedPassword: passwordHash },
  });

  const orgManager = await prisma.organizationManager.upsert({
    where: {
      organizationId_userId: {
        organizationId: org.id,
        userId: managerUser.id,
      },
    },
    create: { organizationId: org.id, userId: managerUser.id },
    update: {},
  });

  await prisma.managerRestaurantAssignment.upsert({
    where: {
      organizationManagerId_restaurantId: {
        organizationManagerId: orgManager.id,
        restaurantId: restaurant.id,
      },
    },
    create: { organizationManagerId: orgManager.id, restaurantId: restaurant.id },
    update: {},
  });
  console.log('  manager: cypressManager@test.com');

  console.log('\nCypress seed complete.');
  console.log('  Credentials (password: asdf):');
  console.log('    restaurant_owner   -> cypressRestaurantOwner@test.com');
  console.log('    restaurant_manager -> cypressManager@test.com');
  console.log('    restaurant slug    -> cypress-test-restaurant');
}

main()
  .catch((e) => {
    console.error('Cypress seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
