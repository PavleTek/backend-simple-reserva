const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const slug = 'la-casona-de-pedro';
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug },
    include: {
      schedules: true,
      zones: {
        include: {
          tables: true
        }
      }
    }
  });

  console.log('Restaurant:', JSON.stringify(restaurant, null, 2));
}

check().catch(console.error).finally(() => prisma.$disconnect());
