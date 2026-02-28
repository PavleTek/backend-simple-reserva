const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seeding...');

  // Seed EmailSender
  const existingSender = await prisma.emailSender.findFirst();
  let emailSender;
  if (!existingSender) {
    emailSender = await prisma.emailSender.create({
      data: { email: 'noreply@simplereserva.com' }
    });
    console.log('Created EmailSender: noreply@simplereserva.com');
  } else {
    emailSender = existingSender;
    console.log('EmailSender already exists, skipping.');
  }

  // Seed Configuration
  const existingConfig = await prisma.configuration.findFirst();
  if (!existingConfig) {
    await prisma.configuration.create({
      data: {
        twoFactorEnabled: false,
        appName: 'SimpleReserva',
        recoveryEmailSenderId: emailSender.id,
      }
    });
    console.log('Created default Configuration.');
  } else {
    console.log('Configuration already exists, skipping.');
  }

  // Seed super admin users
  const existingAdminCount = await prisma.user.count({
    where: { role: 'super_admin' }
  });

  if (existingAdminCount === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 12);

    await prisma.user.create({
      data: {
        email: 'admin@simplereserva.com',
        name: 'Super',
        lastName: 'Admin',
        hashedPassword,
        role: 'super_admin',
      }
    });
    console.log('Created super admin: admin@simplereserva.com (password: admin123)');
  } else {
    console.log(`${existingAdminCount} super admin(s) already exist, skipping.`);
  }

  console.log('Database seeding completed!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
