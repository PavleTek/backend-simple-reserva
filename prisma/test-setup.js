const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🧪 Starting test setup script...');

  // 1. Delete all existing users to start fresh
  console.log('🧹 Cleaning up users...');
  await prisma.user.deleteMany({});

  const testPasswordHash = await bcrypt.hash('asdf', 12);

  // 2. Create Super Admin
  const superAdmin = await prisma.user.create({
    data: {
      email: 'admin@test.com',
      name: 'Admin',
      lastName: 'Test',
      hashedPassword: testPasswordHash,
      role: 'super_admin',
    }
  });
  console.log('✅ Created Super Admin: admin@test.com / asdf');

  // 3. Find or Create "La Casona de Pedro"
  let restaurant = await prisma.restaurant.findUnique({
    where: { slug: 'la-casona-de-pedro' }
  });

  if (!restaurant) {
    console.log('🏠 Restaurant "La Casona de Pedro" not found, creating it...');
    restaurant = await prisma.restaurant.create({
      data: {
        slug: 'la-casona-de-pedro',
        name: 'La Casona de Pedro',
        description: 'Tradición chilena en el corazón de Santiago.',
        address: 'Av. Vitacura 1234, Vitacura, Santiago',
        phone: '+56 2 2234 5678',
        email: 'contacto@lacasona.cl',
        defaultSlotDurationMinutes: 60,
      }
    });
  } else {
    console.log('🏠 Found existing restaurant "La Casona de Pedro".');
  }

  // 4. Create Restaurant Owner and Admin for La Casona
  await prisma.user.create({
    data: {
      email: 'owner@test.com',
      name: 'Owner',
      lastName: 'LaCasona',
      hashedPassword: testPasswordHash,
      role: 'owner',
      restaurantId: restaurant.id
    }
  });
  console.log('✅ Created Restaurant Owner: owner@test.com / asdf');

  await prisma.user.create({
    data: {
      email: 'staff@test.com',
      name: 'Staff',
      lastName: 'LaCasona',
      hashedPassword: testPasswordHash,
      role: 'admin',
      restaurantId: restaurant.id
    }
  });
  console.log('✅ Created Restaurant Admin: staff@test.com / asdf');

  // 5. Clear availability for La Casona (Delete reservations and blocked slots)
  console.log('🔓 Clearing reservations and blocked slots for La Casona...');
  await prisma.reservation.deleteMany({
    where: { restaurantId: restaurant.id }
  });
  await prisma.blockedSlot.deleteMany({
    where: { restaurantId: restaurant.id }
  });

  // 6. Ensure active schedule for all days
  console.log('📅 Updating schedule for La Casona (Open every day 12:00-23:00)...');
  const days = [0, 1, 2, 3, 4, 5, 6];
  for (const day of days) {
    await prisma.schedule.upsert({
      where: {
        restaurantId_dayOfWeek: {
          restaurantId: restaurant.id,
          dayOfWeek: day
        }
      },
      update: {
        openTime: '12:00',
        closeTime: '23:00',
        isActive: true
      },
      create: {
        restaurantId: restaurant.id,
        dayOfWeek: day,
        openTime: '12:00',
        closeTime: '23:00',
        isActive: true
      }
    });
  }

  // 7. Ensure at least one zone and some tables exist
  let zone = await prisma.zone.findFirst({
    where: { restaurantId: restaurant.id, isActive: true }
  });

  if (!zone) {
    console.log('🛋️ Creating a default zone "Terraza"...');
    zone = await prisma.zone.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Terraza',
        sortOrder: 0,
        isActive: true
      }
    });
  }

  const tableCount = await prisma.restaurantTable.count({
    where: { zoneId: zone.id, isActive: true }
  });

  if (tableCount === 0) {
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
  }

  console.log('\n✨ Test setup completed successfully!');
  console.log('--------------------------------------------------');
  console.log('Credentials Summary:');
  console.log('Super Admin:      admin@test.com / asdf');
  console.log('Restaurant Owner: owner@test.com / asdf');
  console.log('Restaurant Admin: staff@test.com / asdf');
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
