#!/usr/bin/env node
/**
 * Resolve migration state when DB already has schema from a previous setup.
 * Run: node scripts/resolve-migrations.js
 *
 * Then run: npx prisma migrate deploy
 */

const { execSync } = require('child_process');
const path = require('path');

const migrationsToResolve = [
  '20260303100000_init_v1',
  // If these fail with "already exists", add them here:
  // '20260303110000_add_plan_config',
  // '20260303120000_add_plan_override',
];

const backendDir = path.join(__dirname, '..');

console.log('Resolving migrations as applied (DB schema already exists)...\n');

for (const name of migrationsToResolve) {
  try {
    execSync(`npx prisma migrate resolve --applied "${name}"`, {
      cwd: backendDir,
      stdio: 'inherit',
    });
    console.log(`✅ Resolved: ${name}\n`);
  } catch (err) {
    console.error(`Failed to resolve ${name}:`, err.message);
    process.exit(1);
  }
}

console.log('Done. Now run: npx prisma migrate deploy');
