const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting comprehensive database seeding...');

  const summary = {
    EmailSender: { created: 0, skipped: 0 },
    Configuration: { created: 0, skipped: 0 },
    Restaurant: { created: 0, skipped: 0 },
    User: { created: 0, skipped: 0 },
    Zone: { created: 0, skipped: 0 },
    RestaurantTable: { created: 0, skipped: 0 },
    Schedule: { created: 0, skipped: 0 },
    BlockedSlot: { created: 0, skipped: 0 },
    Reservation: { created: 0, skipped: 0 },
    Subscription: { created: 0, skipped: 0 },
  };

  // 1. Seed EmailSender
  const existingSenderCount = await prisma.emailSender.count();
  let emailSender;
  if (existingSenderCount === 0) {
    emailSender = await prisma.emailSender.create({
      data: { email: 'noreply@simplereserva.com' }
    });
    summary.EmailSender.created = 1;
    console.log('✅ Created EmailSender: noreply@simplereserva.com');
  } else {
    emailSender = await prisma.emailSender.findFirst();
    summary.EmailSender.skipped = existingSenderCount;
    console.log('ℹ️  EmailSender already exists, skipping.');
  }

  // 2. Seed Configuration
  const existingConfigCount = await prisma.configuration.count();
  if (existingConfigCount === 0) {
    await prisma.configuration.create({
      data: {
        twoFactorEnabled: false,
        appName: 'SimpleReserva',
        recoveryEmailSenderId: emailSender.id,
      }
    });
    summary.Configuration.created = 1;
    console.log('✅ Created default Configuration.');
  } else {
    summary.Configuration.skipped = existingConfigCount;
    console.log('ℹ️  Configuration already exists, skipping.');
  }

  // 3. Seed Restaurants
  const existingRestaurantCount = await prisma.restaurant.count();
  let restaurants = [];
  if (existingRestaurantCount === 0) {
    const restaurantData = [
      {
        slug: 'la-casona-de-pedro',
        name: 'La Casona de Pedro',
        description: 'Tradición chilena en el corazón de Santiago. Carnes a las brasas y los mejores vinos.',
        address: 'Av. Vitacura 1234, Vitacura, Santiago',
        phone: '+56 2 2234 5678',
        email: 'contacto@lacasona.cl',
        defaultSlotDurationMinutes: 60,
      },
      {
        slug: 'el-porton-rojo',
        name: 'El Porton Rojo',
        description: 'Cocina de autor con vista al mar. Mariscos frescos y ambiente bohemio.',
        address: 'Cerro Alegre, Calle Templeman 567, Valparaíso',
        phone: '+56 32 2234 8901',
        email: 'info@elporton.cl',
        defaultSlotDurationMinutes: 90,
      },
      {
        slug: 'sushi-wave',
        name: 'Sushi Wave',
        description: 'Fusión nikkei con los mejores ingredientes de la costa central.',
        address: 'Av. San Martín 890, Viña del Mar',
        phone: '+56 32 2256 7890',
        email: 'hola@sushiwave.cl',
        defaultSlotDurationMinutes: 45,
      }
    ];

    for (const data of restaurantData) {
      const restaurant = await prisma.restaurant.create({ data });
      restaurants.push(restaurant);
    }
    summary.Restaurant.created = restaurants.length;
    console.log(`✅ Created ${restaurants.length} restaurants.`);
  } else {
    restaurants = await prisma.restaurant.findMany();
    summary.Restaurant.skipped = existingRestaurantCount;
    console.log('ℹ️  Restaurants already exist, skipping.');
  }

  // 4. Seed Users (Super Admins, Owners, Admins)
  const existingUserCount = await prisma.user.count();
  if (existingUserCount === 0) {
    const adminHash = await bcrypt.hash('admin123', 12);
    const ownerHash = await bcrypt.hash('owner123', 12);

    const userData = [
      // Super Admins
      { email: 'admin@simplereserva.com', name: 'Super', lastName: 'Admin', hashedPassword: adminHash, role: 'super_admin' },
      { email: 'pavle@simplereserva.com', name: 'Pavle', lastName: 'Admin', hashedPassword: adminHash, role: 'super_admin' },
    ];

    // Add Owners and Admins for each restaurant if they were just created
    if (restaurants.length >= 3) {
      userData.push(
        { email: 'carlos@lacasona.cl', name: 'Carlos', lastName: 'Rodriguez', hashedPassword: ownerHash, role: 'owner', restaurantId: restaurants[0].id },
        { email: 'maria@elporton.cl', name: 'Maria', lastName: 'Gomez', hashedPassword: ownerHash, role: 'owner', restaurantId: restaurants[1].id },
        { email: 'diego@sushiwave.cl', name: 'Diego', lastName: 'Perez', hashedPassword: ownerHash, role: 'owner', restaurantId: restaurants[2].id },
        { email: 'ana@lacasona.cl', name: 'Ana', lastName: 'Soto', hashedPassword: adminHash, role: 'admin', restaurantId: restaurants[0].id },
        { email: 'jose@elporton.cl', name: 'Jose', lastName: 'Muñoz', hashedPassword: adminHash, role: 'admin', restaurantId: restaurants[1].id }
      );
    }

    for (const data of userData) {
      await prisma.user.create({ data });
    }
    summary.User.created = userData.length;
    console.log(`✅ Created ${userData.length} users.`);
  } else {
    summary.User.skipped = existingUserCount;
    console.log('ℹ️  Users already exist, skipping.');
  }

  // 5. Seed Zones
  const existingZoneCount = await prisma.zone.count();
  let zones = [];
  if (existingZoneCount === 0 && restaurants.length >= 3) {
    const zoneData = [
      // La Casona
      { restaurantId: restaurants[0].id, name: 'Terraza', sortOrder: 0 },
      { restaurantId: restaurants[0].id, name: 'Salon Interior', sortOrder: 1 },
      { restaurantId: restaurants[0].id, name: 'Barra', sortOrder: 2 },
      // El Porton
      { restaurantId: restaurants[1].id, name: 'Patio', sortOrder: 0 },
      { restaurantId: restaurants[1].id, name: 'Comedor Principal', sortOrder: 1 },
      // Sushi Wave
      { restaurantId: restaurants[2].id, name: 'Sushi Bar', sortOrder: 0 },
      { restaurantId: restaurants[2].id, name: 'Salon', sortOrder: 1 },
      { restaurantId: restaurants[2].id, name: 'Terraza', sortOrder: 2 },
    ];

    for (const data of zoneData) {
      const zone = await prisma.zone.create({ data });
      zones.push(zone);
    }
    summary.Zone.created = zones.length;
    console.log(`✅ Created ${zones.length} zones.`);
  } else {
    zones = await prisma.zone.findMany();
    summary.Zone.skipped = existingZoneCount;
    console.log('ℹ️  Zones already exist, skipping.');
  }

  // 6. Seed RestaurantTable
  const existingTableCount = await prisma.restaurantTable.count();
  let tables = [];
  if (existingTableCount === 0 && zones.length >= 8) {
    const tableData = [
      // La Casona / Terraza (zones[0])
      { zoneId: zones[0].id, label: 'T1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[0].id, label: 'T2', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[0].id, label: 'T3', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[0].id, label: 'T4', minCapacity: 6, maxCapacity: 8 },
      // La Casona / Salon Interior (zones[1])
      { zoneId: zones[1].id, label: 'S1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[1].id, label: 'S2', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[1].id, label: 'S3', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[1].id, label: 'S4', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[1].id, label: 'S5', minCapacity: 6, maxCapacity: 10 },
      // La Casona / Barra (zones[2])
      { zoneId: zones[2].id, label: 'B1', minCapacity: 1, maxCapacity: 2 },
      { zoneId: zones[2].id, label: 'B2', minCapacity: 1, maxCapacity: 2 },
      { zoneId: zones[2].id, label: 'B3', minCapacity: 1, maxCapacity: 2 },
      // El Porton / Patio (zones[3])
      { zoneId: zones[3].id, label: 'P1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[3].id, label: 'P2', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[3].id, label: 'P3', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[3].id, label: 'P4', minCapacity: 8, maxCapacity: 12 },
      // El Porton / Comedor (zones[4])
      { zoneId: zones[4].id, label: 'C1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[4].id, label: 'C2', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[4].id, label: 'C3', minCapacity: 4, maxCapacity: 6 },
      { zoneId: zones[4].id, label: 'C4', minCapacity: 6, maxCapacity: 8 },
      // Sushi Wave / Sushi Bar (zones[5])
      { zoneId: zones[5].id, label: 'SB1', minCapacity: 1, maxCapacity: 2 },
      { zoneId: zones[5].id, label: 'SB2', minCapacity: 1, maxCapacity: 2 },
      { zoneId: zones[5].id, label: 'SB3', minCapacity: 1, maxCapacity: 2 },
      { zoneId: zones[5].id, label: 'SB4', minCapacity: 1, maxCapacity: 2 },
      // Sushi Wave / Salon (zones[6])
      { zoneId: zones[6].id, label: 'M1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[6].id, label: 'M2', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[6].id, label: 'M3', minCapacity: 4, maxCapacity: 6 },
      // Sushi Wave / Terraza (zones[7])
      { zoneId: zones[7].id, label: 'TZ1', minCapacity: 2, maxCapacity: 4 },
      { zoneId: zones[7].id, label: 'TZ2', minCapacity: 4, maxCapacity: 6 },
    ];

    for (const data of tableData) {
      const table = await prisma.restaurantTable.create({ data });
      tables.push(table);
    }
    summary.RestaurantTable.created = tables.length;
    console.log(`✅ Created ${tables.length} tables.`);
  } else {
    tables = await prisma.restaurantTable.findMany();
    summary.RestaurantTable.skipped = existingTableCount;
    console.log('ℹ️  Tables already exist, skipping.');
  }

  // 7. Seed Schedules
  const existingScheduleCount = await prisma.schedule.count();
  if (existingScheduleCount === 0 && restaurants.length >= 3) {
    const scheduleData = [];
    
    // La Casona: Mon-Sat 12:00-23:00, Sun closed
    for (let i = 0; i < 7; i++) {
      scheduleData.push({
        restaurantId: restaurants[0].id,
        dayOfWeek: i,
        openTime: '12:00',
        closeTime: '23:00',
        isActive: i !== 0, // 0 is Sunday
      });
    }

    // El Porton: Mon-Sun 11:00-22:00
    for (let i = 0; i < 7; i++) {
      scheduleData.push({
        restaurantId: restaurants[1].id,
        dayOfWeek: i,
        openTime: '11:00',
        closeTime: '22:00',
        isActive: true,
      });
    }

    // Sushi Wave: Tue-Sun 13:00-23:00, Mon closed
    for (let i = 0; i < 7; i++) {
      scheduleData.push({
        restaurantId: restaurants[2].id,
        dayOfWeek: i,
        openTime: '13:00',
        closeTime: '23:00',
        isActive: i !== 1, // 1 is Monday
      });
    }

    for (const data of scheduleData) {
      await prisma.schedule.create({ data });
    }
    summary.Schedule.created = scheduleData.length;
    console.log(`✅ Created ${scheduleData.length} schedule entries.`);
  } else {
    summary.Schedule.skipped = existingScheduleCount;
    console.log('ℹ️  Schedules already exist, skipping.');
  }

  // 8. Seed BlockedSlots
  const existingBlockedCount = await prisma.blockedSlot.count();
  if (existingBlockedCount === 0 && restaurants.length >= 3) {
    const now = new Date();
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
    nextMonday.setHours(0, 0, 0, 0);
    const nextMondayEnd = new Date(nextMonday);
    nextMondayEnd.setHours(23, 59, 59, 999);

    const nextSaturday = new Date(now);
    nextSaturday.setDate(now.getDate() + ((6 + 7 - now.getDay()) % 7 || 7));
    nextSaturday.setHours(18, 0, 0, 0);
    const nextSaturdayEnd = new Date(nextSaturday);
    nextSaturdayEnd.setHours(22, 0, 0, 0);

    const twoDaysFromNow = new Date(now);
    twoDaysFromNow.setDate(now.getDate() + 2);
    twoDaysFromNow.setHours(13, 0, 0, 0);
    const twoDaysFromNowEnd = new Date(twoDaysFromNow);
    twoDaysFromNowEnd.setHours(15, 0, 0, 0);

    const blockedData = [
      { restaurantId: restaurants[0].id, startDatetime: nextMonday, endDatetime: nextMondayEnd, reason: 'Fumigación programada' },
      { restaurantId: restaurants[1].id, startDatetime: nextSaturday, endDatetime: nextSaturdayEnd, reason: 'Evento privado' },
      { restaurantId: restaurants[2].id, startDatetime: twoDaysFromNow, endDatetime: twoDaysFromNowEnd, reason: 'Mantenimiento de equipos' },
    ];

    for (const data of blockedData) {
      await prisma.blockedSlot.create({ data });
    }
    summary.BlockedSlot.created = blockedData.length;
    console.log(`✅ Created ${blockedData.length} blocked slots.`);
  } else {
    summary.BlockedSlot.skipped = existingBlockedCount;
    console.log('ℹ️  Blocked slots already exist, skipping.');
  }

  // 9. Seed Reservations
  const existingReservationCount = await prisma.reservation.count();
  if (existingReservationCount === 0 && restaurants.length >= 3 && tables.length > 0) {
    const now = new Date();
    const reservationData = [];

    const names = ['Juan Pérez', 'Andrés Bello', 'Michelle Bachelet', 'Alexis Sánchez', 'Arturo Vidal', 'Violeta Parra', 'Pablo Neruda', 'Gabriela Mistral', 'Isabel Allende', 'Pedro Pascal', 'Cecilia Bolocco', 'Felipe Camiroaga', 'Tonka Tomicic', 'Luis Jara', 'Mario Kreutzberger', 'Daniela Vega', 'Benjamín Vicuña', 'Paz Bascuñán', 'Jorge Zabaleta', 'Carolina Arregui'];
    
    // Past reservations (last 7 days)
    for (let i = 0; i < 10; i++) {
      const resDate = new Date(now);
      resDate.setDate(now.getDate() - (i + 1));
      resDate.setHours(13 + (i % 8), 0, 0, 0);
      
      const restIdx = i % 3;
      const restTables = tables.filter(t => zones.find(z => z.id === t.zoneId && z.restaurantId === restaurants[restIdx].id));
      const table = restTables[i % restTables.length];

      reservationData.push({
        restaurantId: restaurants[restIdx].id,
        tableId: table.id,
        customerName: names[i],
        customerPhone: `+56 9 ${Math.floor(10000000 + Math.random() * 90000000)}`,
        customerEmail: `customer${i}@example.com`,
        partySize: Math.min(table.maxCapacity, 2 + (i % 4)),
        dateTime: resDate,
        durationMinutes: restaurants[restIdx].defaultSlotDurationMinutes,
        status: i % 5 === 0 ? 'no_show' : (i % 4 === 0 ? 'cancelled' : 'completed'),
        notes: i % 3 === 0 ? 'Sin gluten por favor' : null,
      });
    }

    // Upcoming reservations (next 7 days)
    for (let i = 0; i < 15; i++) {
      const resDate = new Date(now);
      resDate.setDate(now.getDate() + (i % 7) + 1);
      resDate.setHours(19 + (i % 3), 0, 0, 0);
      
      const restIdx = i % 3;
      const restTables = tables.filter(t => zones.find(z => z.id === t.zoneId && z.restaurantId === restaurants[restIdx].id));
      const table = restTables[i % restTables.length];

      reservationData.push({
        restaurantId: restaurants[restIdx].id,
        tableId: table.id,
        customerName: names[i + 5],
        customerPhone: `+56 9 ${Math.floor(10000000 + Math.random() * 90000000)}`,
        customerEmail: `customer${i + 10}@example.com`,
        partySize: Math.min(table.maxCapacity, 2 + (i % 4)),
        dateTime: resDate,
        durationMinutes: restaurants[restIdx].defaultSlotDurationMinutes,
        status: 'confirmed',
        notes: i % 4 === 0 ? 'Celebración de cumpleaños' : null,
      });
    }

    for (const data of reservationData) {
      await prisma.reservation.create({ data });
    }
    summary.Reservation.created = reservationData.length;
    console.log(`✅ Created ${reservationData.length} reservations.`);
  } else {
    summary.Reservation.skipped = existingReservationCount;
    console.log('ℹ️  Reservations already exist, skipping.');
  }

  // 10. Seed Subscriptions
  const existingSubCount = await prisma.subscription.count();
  if (existingSubCount === 0 && restaurants.length >= 3) {
    const now = new Date();
    const subData = [
      {
        restaurantId: restaurants[0].id,
        plan: 'premium',
        status: 'active',
        startDate: new Date(new Date().setMonth(now.getMonth() - 6)),
      },
      {
        restaurantId: restaurants[1].id,
        plan: 'basic',
        status: 'active',
        startDate: new Date(new Date().setMonth(now.getMonth() - 3)),
      },
      {
        restaurantId: restaurants[2].id,
        plan: 'free',
        status: 'active',
        startDate: new Date(new Date().setMonth(now.getMonth() - 1)),
      }
    ];

    for (const data of subData) {
      await prisma.subscription.create({ data });
    }
    summary.Subscription.created = subData.length;
    console.log(`✅ Created ${subData.length} subscriptions.`);
  } else {
    summary.Subscription.skipped = existingSubCount;
    console.log('ℹ️  Subscriptions already exist, skipping.');
  }

  console.log('\n📊 Seeding Summary:');
  console.table(summary);

  console.log('\n🔑 Credentials Summary:');
  console.log('--------------------------------------------------');
  console.log('Super Admins (admin123):');
  console.log('  admin@simplereserva.com');
  console.log('  pavle@simplereserva.com');
  console.log('\nRestaurant Owners (owner123):');
  console.log('  carlos@lacasona.cl  (La Casona de Pedro)');
  console.log('  maria@elporton.cl   (El Porton Rojo)');
  console.log('  diego@sushiwave.cl  (Sushi Wave)');
  console.log('\nRestaurant Admins (admin123):');
  console.log('  ana@lacasona.cl     (La Casona de Pedro)');
  console.log('  jose@elporton.cl    (El Porton Rojo)');
  console.log('--------------------------------------------------');

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
