const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🧪 Starting test setup script...');

  // 1. Delete all existing users to start fresh
  console.log('🧹 Cleaning up users and organizations...');
  await prisma.user.deleteMany({});
  await prisma.restaurantOrganization.deleteMany({});
  // Cascading deletes should handle the rest, but let's be safe if needed
  // However, with organizations owning restaurants, deleting users/orgs is a good start.

  const testPasswordHash = await bcrypt.hash('asdf', 12);

  // 2. Create Super Admin
  await prisma.user.create({
    data: {
      email: 'adminP',
      name: 'Admin',
      lastName: 'Platform',
      hashedPassword: testPasswordHash,
      role: 'super_admin',
    }
  });
  console.log('✅ Created Super Admin: adminP / asdf');

  // 3. Find default plan
  const defaultPlan = await prisma.planConfig.findFirst({
    where: { plan: 'profesional', isDefaultPlan: true }
  }) || await prisma.planConfig.findFirst({
    where: { plan: 'profesional' }
  });

  if (!defaultPlan) {
    throw new Error('No PlanConfig found. Please run seed.js first.');
  }

  // 4. Create Restaurant Owner and Organization
  const owner = await prisma.user.create({
    data: {
      email: 'ownerP',
      name: 'Owner',
      lastName: 'Platform',
      hashedPassword: testPasswordHash,
      role: 'restaurant_owner',
    }
  });

  const organization = await prisma.restaurantOrganization.create({
    data: {
      name: 'La Casona Group',
      ownerId: owner.id,
      planConfigId: defaultPlan.id,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    }
  });

  await prisma.subscription.create({
    data: {
      organizationId: organization.id,
      plan: defaultPlan.plan,
      status: 'trial',
    }
  });
  console.log('✅ Created Restaurant Owner and Organization: ownerP / asdf');

  // 5. Create Restaurant "La Casona de Pedro"
  const restaurant = await prisma.restaurant.create({
    data: {
      organizationId: organization.id,
      slug: 'la-casona-de-pedro',
      name: 'La Casona de Pedro',
      description: 'Tradición chilena en el corazón de Santiago.',
      address: 'Av. Vitacura 1234, Vitacura, Santiago',
      phone: '+56 2 2234 5678',
      email: 'contacto@lacasona.cl',
      defaultSlotDurationMinutes: 60,
    }
  });
  console.log('🏠 Created restaurant "La Casona de Pedro".');

  // 6. Create Restaurant Manager for La Casona
  const manager = await prisma.user.create({
    data: {
      email: 'staff@test.com',
      name: 'Staff',
      lastName: 'LaCasona',
      hashedPassword: testPasswordHash,
      role: 'restaurant_manager',
    }
  });

  const orgManager = await prisma.organizationManager.create({
    data: {
      organizationId: organization.id,
      userId: manager.id,
    }
  });

  await prisma.managerRestaurantAssignment.create({
    data: {
      organizationManagerId: orgManager.id,
      restaurantId: restaurant.id,
    }
  });
  console.log('✅ Created Restaurant Manager: staff@test.com / asdf');

  // 7. Ensure active schedule for all days
  console.log('📅 Updating schedule for La Casona (Open every day 12:00-23:00)...');
  const days = [0, 1, 2, 3, 4, 5, 6];
  for (const day of days) {
    await prisma.schedule.create({
      data: {
        restaurantId: restaurant.id,
        dayOfWeek: day,
        openTime: '12:00',
        closeTime: '23:00',
        isActive: true
      }
    });
  }

  // 8. Create a default zone and tables
  console.log('🛋️ Creating a default zone "Terraza"...');
  const zone = await prisma.zone.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Terraza',
      sortOrder: 0,
      isActive: true
    }
  });

  console.log('🪑 Creating 5 default tables for "Terraza"...');
  const tableData = [
    { zoneId: zone.id, label: 'T1', minCapacity: 2, maxCapacity: 4 },
    { zoneId: zone.id, label: 'T2', minCapacity: 2, maxCapacity: 4 },
    { zoneId: zone.id, label: 'T3', minCapacity: 4, maxCapacity: 6 },
    { zoneId: zone.id, label: 'T4', minCapacity: 4, maxCapacity: 6 },
    { zoneId: zone.id, label: 'T5', minCapacity: 6, maxCapacity: 10 },
  ];
  for (const data of tableData) {
    await prisma.restaurantTable.create({ data });
  }

  console.log('\n✨ Test setup completed successfully!');
  console.log('--------------------------------------------------');
  console.log('Credentials Summary:');
  console.log('Super Admin:        adminP / asdf');
  console.log('Restaurant Owner:   ownerP / asdf');
  console.log('Restaurant Manager: staff@test.com / asdf');
  console.log('--------------------------------------------------');
}

main()
  .catch((e) => {
    console.error('❌ Error during test setup:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
