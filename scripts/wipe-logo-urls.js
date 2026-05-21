/**
 * One-time migration script: clears all Restaurant.logoUrl values.
 *
 * Run ONCE after deploying the R2 logo storage change, before owners re-upload
 * their logos via the new flow. Disk files in uploads/logos/ can be removed
 * manually from the server after this script completes.
 *
 * Usage:
 *   node scripts/wipe-logo-urls.js
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.restaurant.updateMany({
    where: { logoUrl: { not: null } },
    data: { logoUrl: null },
  });
  console.log(`Cleared logoUrl for ${result.count} restaurant(s).`);
}

main()
  .catch((err) => {
    console.error('Error running wipe-logo-urls:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
