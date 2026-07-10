#!/usr/bin/env node
'use strict';

/**
 * Elimina todos los datos creados por seed-perf.js: organización de prueba,
 * restaurantes, zonas, mesas, reservas, suscripción y el usuario dueño de
 * prueba. No toca ningún otro dato (identificados solo por OWNER_EMAIL).
 *
 * Uso: node scripts/perf/cleanup-perf.js
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { OWNER_EMAIL } = require('./perfConfig');

const prisma = new PrismaClient();

async function main() {
  const owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner) {
    console.log('[cleanup-perf] No hay datos de prueba de performance para limpiar.');
    return;
  }

  const org = await prisma.restaurantOrganization.findFirst({ where: { ownerId: owner.id } });
  if (org) {
    const restaurantCount = await prisma.restaurant.count({ where: { organizationId: org.id } });
    await prisma.restaurantOrganization.delete({ where: { id: org.id } });
    console.log(
      `[cleanup-perf] Organización "${org.name}" eliminada (cascada: ${restaurantCount} restaurante(s), ` +
        'mesas, reservas, suscripción).'
    );
  }

  await prisma.user.delete({ where: { id: owner.id } });
  console.log('[cleanup-perf] Usuario de prueba eliminado.');
}

main()
  .catch((err) => {
    console.error('[cleanup-perf] Error:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
