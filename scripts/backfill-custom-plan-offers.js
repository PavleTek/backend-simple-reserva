#!/usr/bin/env node
'use strict';

/**
 * Migra RestaurantOrganization.customPlanId (legacy) → CustomPlanOffer.
 *
 * Uso:
 *   node scripts/backfill-custom-plan-offers.js           # dry-run (default)
 *   node scripts/backfill-custom-plan-offers.js --apply   # escribe en DB
 */

const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');

async function main() {
  const orgs = await prisma.restaurantOrganization.findMany({
    where: { customPlanId: { not: null } },
    select: { id: true, name: true, customPlanId: true },
  });

  if (!orgs.length) {
    console.log('No hay organizaciones con customPlanId. Nada que migrar.');
    return;
  }

  console.log(`${APPLY ? 'APLICAR' : 'DRY-RUN'}: ${orgs.length} organización(es) con customPlanId legacy.\n`);

  let created = 0;
  let skipped = 0;

  for (const org of orgs) {
    const planId = org.customPlanId;
    const existing = await prisma.customPlanOffer.findUnique({
      where: { planId_organizationId: { planId, organizationId: org.id } },
    });

    if (existing) {
      console.log(`  [skip] ${org.name} (${org.id}) — ya tiene CustomPlanOffer para plan ${planId}`);
      skipped += 1;
      continue;
    }

    console.log(`  [${APPLY ? 'create' : 'would create'}] ${org.name} (${org.id}) → offer planId=${planId}`);

    if (APPLY) {
      await prisma.customPlanOffer.create({
        data: {
          planId,
          organizationId: org.id,
          selfServicePlanChanges: true,
          selfServiceBillingStrategyChanges: true,
        },
      });
    }
    created += 1;
  }

  console.log(`\nResumen: ${created} oferta(s) ${APPLY ? 'creadas' : 'a crear'}, ${skipped} omitidas (ya existían).`);
  if (!APPLY && created > 0) {
    console.log('Ejecuta con --apply para persistir.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
