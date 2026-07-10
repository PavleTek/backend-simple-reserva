#!/usr/bin/env node
'use strict';

/**
 * Mide latencia, tamaño de payload y (si el server corre con PERF_LOG=1)
 * cantidad de queries de los endpoints críticos del flujo de reservas, para
 * cada escenario de tamaño sembrado por seed-perf.js.
 *
 * Requiere:
 *  - Datos sembrados: node scripts/perf/seed-perf.js
 *  - Backend corriendo (recomendado con PERF_LOG=1 para ver queryCount):
 *      PERF_LOG=1 npm run dev
 *
 * Uso:
 *   node scripts/perf/benchmark.js
 *   PERF_BASE_URL=http://localhost:3000 PERF_OUT_FILE=antes.json node scripts/perf/benchmark.js
 *
 * Compara dos corridas (antes/después de optimizar) con:
 *   node scripts/perf/compare.js antes.json despues.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { generateToken } = require('../../src/utils/jwt');
const { OWNER_EMAIL, SCENARIOS, dateStrOffset } = require('./perfConfig');

const prisma = new PrismaClient();

const BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:3000';
const DEFAULT_REPS = 5;

async function timeRequest(url, { headers, reps = DEFAULT_REPS } = {}) {
  const durationsMs = [];
  let bytes = 0;
  let queryCount = null;
  let status = null;

  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    const res = await fetch(url, { headers });
    const text = await res.text();
    durationsMs.push(performance.now() - start);
    bytes = Buffer.byteLength(text);
    queryCount = res.headers.get('x-perf-query-count');
    status = res.status;
  }

  durationsMs.sort((a, b) => a - b);
  const avg = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;

  return {
    minMs: Math.round(durationsMs[0]),
    p50Ms: Math.round(durationsMs[Math.floor(durationsMs.length / 2)]),
    maxMs: Math.round(durationsMs[durationsMs.length - 1]),
    avgMs: Math.round(avg),
    bytes,
    queryCount: queryCount != null ? Number(queryCount) : null,
    status,
  };
}

function buildChecks({ slug, restaurantId, dates, authHeaders }) {
  return [
    { label: 'restaurant público', url: `${BASE_URL}/api/public/restaurants/${slug}` },
    {
      label: 'availability hoy p=2 (público)',
      url: `${BASE_URL}/api/public/restaurants/${slug}/availability?date=${dates.today}&partySize=2`,
    },
    {
      label: 'availability +3d p=4 (público)',
      url: `${BASE_URL}/api/public/restaurants/${slug}/availability?date=${dates.near}&partySize=4`,
    },
    {
      label: 'availability +20d p=2 (público)',
      url: `${BASE_URL}/api/public/restaurants/${slug}/availability?date=${dates.far}&partySize=2`,
    },
    {
      label: 'next-available peor caso (público)',
      url: `${BASE_URL}/api/public/restaurants/${slug}/next-available?date=${dates.today}&partySize=999`,
      reps: 3,
    },
    {
      label: 'service-view hoy (panel)',
      url: `${BASE_URL}/api/restaurant/${restaurantId}/service-view?date=${dates.today}`,
      headers: authHeaders,
    },
    {
      label: 'tables/status hoy (panel)',
      url: `${BASE_URL}/api/restaurant/${restaurantId}/tables/status?date=${dates.today}`,
      headers: authHeaders,
    },
    {
      label: 'reservations hoy (panel)',
      url: `${BASE_URL}/api/restaurant/${restaurantId}/reservations?date=${dates.today}`,
      headers: authHeaders,
    },
    {
      label: 'availability hoy p=2 (panel)',
      url: `${BASE_URL}/api/restaurant/${restaurantId}/availability?date=${dates.today}&partySize=2`,
      headers: authHeaders,
    },
    {
      label: 'available-tables hoy 20:00 (panel)',
      url: `${BASE_URL}/api/restaurant/${restaurantId}/available-tables?date=${dates.today}&time=20:00&partySize=2`,
      headers: authHeaders,
    },
  ];
}

async function main() {
  const owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner) {
    console.error('[benchmark] No hay datos de prueba. Corre primero: node scripts/perf/seed-perf.js');
    process.exitCode = 1;
    return;
  }
  const authHeaders = { Authorization: `Bearer ${generateToken(owner)}` };

  const dates = { today: dateStrOffset(0), near: dateStrOffset(3), far: dateStrOffset(20) };
  const results = [];

  console.log(`[benchmark] Contra ${BASE_URL} — si el server corre con PERF_LOG=1 se reporta queryCount.\n`);

  for (const scenario of SCENARIOS) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: scenario.slug },
      select: { id: true },
    });
    if (!restaurant) {
      console.warn(`[benchmark] ${scenario.slug} no existe — se omite. Corre seed-perf.js primero.`);
      continue;
    }

    console.log(`=== ${scenario.name} (${scenario.tableCount} mesas) ===`);
    const checks = buildChecks({ slug: scenario.slug, restaurantId: restaurant.id, dates, authHeaders });

    for (const check of checks) {
      const stats = await timeRequest(check.url, { headers: check.headers, reps: check.reps });
      results.push({ scenario: scenario.slug, tableCount: scenario.tableCount, label: check.label, ...stats });
      const queries = stats.queryCount != null ? stats.queryCount : 'n/a';
      console.log(
        `  ${check.label.padEnd(34)} avg=${String(stats.avgMs).padStart(5)}ms  p50=${String(stats.p50Ms).padStart(5)}ms  ` +
          `max=${String(stats.maxMs).padStart(5)}ms  bytes=${String(stats.bytes).padStart(7)}  queries=${queries}  status=${stats.status}`
      );
    }
    console.log('');
  }

  const outFile = process.env.PERF_OUT_FILE || path.join(__dirname, `results-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`[benchmark] Resultados guardados en ${outFile}`);
}

main()
  .catch((err) => {
    console.error('[benchmark] Error:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
