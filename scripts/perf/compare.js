#!/usr/bin/env node
'use strict';

/**
 * Compara dos archivos de resultados de benchmark.js (antes/después de optimizar).
 *
 * Uso: node scripts/perf/compare.js antes.json despues.json
 */

const fs = require('fs');

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('Uso: node scripts/perf/compare.js <antes.json> <despues.json>');
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));

function keyOf(row) {
  return `${row.scenario}::${row.label}`;
}

const afterByKey = new Map(after.map((row) => [keyOf(row), row]));

console.log(`Comparando ${beforeFile} → ${afterFile}\n`);

for (const b of before) {
  const a = afterByKey.get(keyOf(b));
  if (!a) continue;
  const deltaMs = a.avgMs - b.avgMs;
  const pct = b.avgMs > 0 ? Math.round((deltaMs / b.avgMs) * 100) : 0;
  const deltaQueries =
    a.queryCount != null && b.queryCount != null ? a.queryCount - b.queryCount : null;
  const arrow = deltaMs <= 0 ? '↓' : '↑';
  console.log(
    `[${b.scenario}] ${b.label.padEnd(34)} ${b.avgMs}ms → ${a.avgMs}ms (${arrow}${Math.abs(pct)}%)` +
      (deltaQueries != null ? `  queries ${b.queryCount} → ${a.queryCount}` : '')
  );
}
