#!/usr/bin/env node
/**
 * Production-safe prisma migrate deploy:
 * 1. Dedupe duplicate isActiveSubscription rows (idempotent).
 * 2. Mark known failed migration as rolled back so deploy can retry.
 * 3. prisma migrate deploy
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const BACKEND_DIR = path.join(__dirname, '..');
const DEDUPE_SQL_PATH = path.join(BACKEND_DIR, 'prisma/scripts/dedupe-active-subscriptions.sql');
const BILLING_HARDENING_MIGRATION = '20260602000001_billing_hardening_active_unique';

function run(cmd) {
  execSync(cmd, { cwd: BACKEND_DIR, stdio: 'inherit' });
}

async function countDuplicateActiveOrgs(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS cnt
    FROM (
      SELECT "organizationId"
      FROM "Subscription"
      WHERE "isActiveSubscription" = true
      GROUP BY "organizationId"
      HAVING COUNT(*) > 1
    ) dupes
  `;
  return rows[0]?.cnt ?? 0;
}

async function listFailedMigrations(prisma) {
  return prisma.$queryRaw`
    SELECT migration_name, started_at
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL
      AND rolled_back_at IS NULL
      AND started_at IS NOT NULL
  `;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const dupesBefore = await countDuplicateActiveOrgs(prisma);
    if (dupesBefore > 0) {
      console.log(`[migrate-deploy] ${dupesBefore} org(s) con más de una suscripción activa; ejecutando dedupe…`);
      const sql = fs.readFileSync(DEDUPE_SQL_PATH, 'utf8');
      await prisma.$executeRawUnsafe(sql);
      const dupesAfter = await countDuplicateActiveOrgs(prisma);
      if (dupesAfter > 0) {
        throw new Error(`[migrate-deploy] Tras dedupe siguen ${dupesAfter} org(s) con duplicados activos`);
      }
      console.log('[migrate-deploy] Dedupe completado.');
    }

    const failed = await listFailedMigrations(prisma);
    for (const row of failed) {
      const name = row.migration_name;
      console.log(`[migrate-deploy] Migración fallida detectada: ${name} (started ${row.started_at})`);
      if (name === BILLING_HARDENING_MIGRATION) {
        run(`npx prisma migrate resolve --rolled-back "${name}"`);
        console.log(`[migrate-deploy] Marcada como rolled back: ${name}`);
      } else {
        throw new Error(
          `[migrate-deploy] Hay una migración fallida no recuperable automáticamente: ${name}. `
            + 'Resuélvela manualmente con prisma migrate resolve.',
        );
      }
    }

    console.log('[migrate-deploy] Aplicando migraciones pendientes…');
    run('npx prisma migrate deploy');
    console.log('[migrate-deploy] Listo.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
