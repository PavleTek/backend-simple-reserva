#!/usr/bin/env node
'use strict';

/**
 * Seed de datos sintéticos para medir performance con muchas mesas.
 *
 * Crea una organización y usuario dedicados exclusivamente a pruebas de carga
 * (ver perfConfig.js), con un restaurante por cada escenario de tamaño
 * (20/40/80/120 mesas), reservas densas en los próximos días y un histórico
 * grande, mesas bloqueadas y (en el escenario más grande) turnos almuerzo/cena.
 *
 * Es aislado y reversible: no toca ningún dato existente y todo puede
 * eliminarse con `node scripts/perf/cleanup-perf.js`.
 *
 * Idempotente: si un restaurante del escenario ya existe, se omite (para
 * regenerar con otros números, corre primero cleanup-perf.js).
 *
 * Uso: node scripts/perf/seed-perf.js
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { parseInTimezone, getDayOfWeekInTimezone } = require('../../src/utils/timezone');
const { TIMEZONE, OWNER_EMAIL, ORG_NAME, SCENARIOS, FUTURE_DENSE_DAYS, dateStrOffset } = require('./perfConfig');

const prisma = new PrismaClient();

const ZONE_COUNT = 4;
const TABLE_CAPACITY_CYCLE = [2, 2, 4, 4, 6, 8];
const PHONE_POOL_SIZE = 60; // clientes recurrentes sintéticos por restaurante
const CHUNK_SIZE = 500;
const DENSE_TIMES_CONTINUOUS = ['13:00', '13:30', '14:00', '19:30', '20:00', '20:30', '21:00'];
const DENSE_TIMES_TURNOS = ['13:00', '13:30', '14:00', '20:00', '20:30', '21:00'];
const HISTORICAL_STATUSES = ['completed', 'completed', 'completed', 'cancelled', 'no_show'];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

function fakePhone(idx) {
  return `+569${String(10000000 + (idx % PHONE_POOL_SIZE)).padStart(8, '0')}`;
}

function businessDateFor(dateStr) {
  return new Date(`${dateStr}T12:00:00.000Z`);
}

async function ensurePlan() {
  const plan = await prisma.plan.findUnique({ where: { productSKU: 'plan-premium' } });
  if (!plan) {
    throw new Error(
      '[seed-perf] No se encontró el plan "plan-premium". Corre el seed base (npm run seed) en una DB vacía primero.'
    );
  }
  return plan;
}

async function ensureOwnerAndOrg(planId) {
  let owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner) {
    const hashedPassword = await bcrypt.hash('perf-test-not-a-real-account', 12);
    owner = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        name: 'Perf',
        lastName: 'Test',
        hashedPassword,
        role: 'restaurant_owner',
        country: 'CL',
      },
    });
    console.log(`[seed-perf] Usuario dueño de prueba creado: ${OWNER_EMAIL}`);
  }

  let org = await prisma.restaurantOrganization.findFirst({ where: { ownerId: owner.id } });
  if (!org) {
    org = await prisma.restaurantOrganization.create({
      data: { name: ORG_NAME, ownerId: owner.id, planId, billingCountry: 'CL' },
    });
    console.log(`[seed-perf] Organización de prueba creada: ${ORG_NAME}`);
  }

  const activeSub = await prisma.subscription.findFirst({
    where: { organizationId: org.id, isActiveSubscription: true },
  });
  if (!activeSub) {
    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId,
        status: 'active',
        isActiveSubscription: true,
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });
    console.log('[seed-perf] Suscripción activa creada para la organización de prueba.');
  }

  return org;
}

async function createZonesAndTables(restaurant, tableCount) {
  const zones = [];
  for (let i = 0; i < ZONE_COUNT; i++) {
    const zone = await prisma.zone.create({
      data: { restaurantId: restaurant.id, name: `Salón ${i + 1}`, sortOrder: i },
    });
    zones.push(zone);
  }

  const tables = [];
  for (let i = 0; i < tableCount; i++) {
    const zone = zones[i % zones.length];
    const maxCapacity = TABLE_CAPACITY_CYCLE[i % TABLE_CAPACITY_CYCLE.length];
    const table = await prisma.restaurantTable.create({
      data: {
        zoneId: zone.id,
        label: `M${i + 1}`,
        minCapacity: 1,
        maxCapacity,
        sortOrder: i,
      },
    });
    tables.push(table);
  }

  return { zones, tables };
}

async function createSchedules(restaurant, turnos) {
  for (let dow = 0; dow <= 6; dow++) {
    await prisma.schedule.create({
      data: {
        restaurantId: restaurant.id,
        dayOfWeek: dow,
        openTime: '12:00',
        closeTime: '23:30',
        ...(turnos
          ? {
              lunchStartTime: '12:00',
              lunchEndTime: '16:00',
              dinnerStartTime: '19:00',
              dinnerEndTime: '23:30',
            }
          : {}),
      },
    });
  }
}

async function createBlockedSlotAndLinkedTables(restaurant, tables) {
  const blockDate = dateStrOffset(4);
  await prisma.blockedSlot.create({
    data: {
      restaurantId: restaurant.id,
      startDatetime: parseInTimezone(blockDate, '15:00', TIMEZONE),
      endDatetime: parseInTimezone(blockDate, '18:00', TIMEZONE),
      reason: '[PERF] Evento privado (dato de prueba)',
    },
  });

  const pairCount = Math.floor(tables.length * 0.1);
  for (let i = 0; i < pairCount; i++) {
    const trigger = tables[i * 2];
    const blocked = tables[i * 2 + 1];
    if (!trigger || !blocked) break;
    await prisma.tableBlockRule.create({
      data: { restaurantId: restaurant.id, triggerTableId: trigger.id, blockedTableId: blocked.id },
    });
  }
}

function buildDenseReservationRows(restaurant, tables, turnos) {
  const rows = [];
  let phoneIdx = 0;
  const times = turnos ? DENSE_TIMES_TURNOS : DENSE_TIMES_CONTINUOUS;

  for (let dayOffset = 0; dayOffset < FUTURE_DENSE_DAYS; dayOffset++) {
    const dateStr = dateStrOffset(dayOffset);
    const dow = getDayOfWeekInTimezone(dateStr, TIMEZONE);
    const isWeekend = dow === 5 || dow === 6;
    const fillRatio = isWeekend ? 0.85 : 0.55;

    for (const table of tables) {
      if (Math.random() > fillRatio) continue;
      phoneIdx += 1;
      const time = pick(times);
      const partySize = randomInt(1, table.maxCapacity);
      rows.push({
        restaurantId: restaurant.id,
        tableId: table.id,
        customerName: `Cliente Perf ${phoneIdx % PHONE_POOL_SIZE}`,
        customerPhone: fakePhone(phoneIdx),
        partySize,
        dateTime: parseInTimezone(dateStr, time, TIMEZONE),
        businessDate: businessDateFor(dateStr),
        durationMinutes: 90,
        status: dayOffset === 0 && Math.random() < 0.3 ? 'arrived' : 'confirmed',
        source: 'web',
      });
    }
  }

  return rows;
}

function buildHistoricalReservationRows(restaurant, tables, historicalCount) {
  const rows = [];
  for (let i = 0; i < historicalCount; i++) {
    const daysAgo = randomInt(1, 365);
    const dateStr = dateStrOffset(-daysAgo);
    const table = pick(tables);
    const time = pick([...DENSE_TIMES_CONTINUOUS]);
    const partySize = randomInt(1, table.maxCapacity);
    const phoneN = randomInt(0, PHONE_POOL_SIZE - 1);
    rows.push({
      restaurantId: restaurant.id,
      tableId: table.id,
      customerName: `Cliente Perf ${phoneN}`,
      customerPhone: fakePhone(phoneN),
      partySize,
      dateTime: parseInTimezone(dateStr, time, TIMEZONE),
      businessDate: businessDateFor(dateStr),
      durationMinutes: 90,
      status: pick(HISTORICAL_STATUSES),
      source: 'web',
    });
  }
  return rows;
}

async function insertReservationsInChunks(rows) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await prisma.reservation.createMany({ data: rows.slice(i, i + CHUNK_SIZE) });
  }
}

async function seedScenario(org, scenario) {
  const existing = await prisma.restaurant.findUnique({ where: { slug: scenario.slug } });
  if (existing) {
    console.log(`[seed-perf] ${scenario.slug} ya existe — se omite (corre cleanup-perf.js para regenerar).`);
    return;
  }

  console.log(`[seed-perf] Creando ${scenario.name}…`);

  const restaurant = await prisma.restaurant.create({
    data: {
      organizationId: org.id,
      slug: scenario.slug,
      name: scenario.name,
      timezone: TIMEZONE,
      scheduleMode: scenario.turnos ? 'service_periods' : 'continuous',
      slotIntervalMinutes: 30,
      defaultSlotDurationMinutes: 90,
      holdsEnabled: true,
      bookingPageIndexable: false,
    },
  });

  const { tables } = await createZonesAndTables(restaurant, scenario.tableCount);
  await createSchedules(restaurant, scenario.turnos);
  await createBlockedSlotAndLinkedTables(restaurant, tables);

  const denseRows = buildDenseReservationRows(restaurant, tables, scenario.turnos);
  const historicalRows = buildHistoricalReservationRows(restaurant, tables, scenario.historicalCount);
  await insertReservationsInChunks([...denseRows, ...historicalRows]);

  console.log(
    `[seed-perf] ${scenario.slug}: ${tables.length} mesas, ${ZONE_COUNT} zonas, ` +
      `${denseRows.length} reservas en próximos ${FUTURE_DENSE_DAYS} días, ${historicalRows.length} históricas.`
  );
}

async function main() {
  const startedAt = Date.now();
  const plan = await ensurePlan();
  const org = await ensureOwnerAndOrg(plan.id);

  for (const scenario of SCENARIOS) {
    await seedScenario(org, scenario);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[seed-perf] Listo en ${elapsedSec}s. Restaurantes de prueba:`);
  for (const s of SCENARIOS) {
    console.log(`  - ${s.slug} (${s.tableCount} mesas)`);
  }
  console.log('\nPara medir: node scripts/perf/benchmark.js');
  console.log('Para limpiar estos datos: node scripts/perf/cleanup-perf.js');
}

main()
  .catch((err) => {
    console.error('[seed-perf] Error:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
