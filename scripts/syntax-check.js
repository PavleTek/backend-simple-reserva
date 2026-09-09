#!/usr/bin/env node
'use strict';

/**
 * Parse-check every backend JS file. Catches SyntaxError (duplicate const,
 * leftover merge markers, invalid syntax) without executing the app.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['src', 'scripts', 'prisma'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((rel) => walk(path.join(ROOT, rel))).sort();
if (files.length === 0) {
  console.error('[syntax-check] no JS files found');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed += 1;
    const rel = path.relative(ROOT, file);
    process.stderr.write(result.stderr || result.stdout || `[syntax-check] failed: ${rel}\n`);
  }
}

if (failed) {
  console.error(`[syntax-check] ${failed} file(s) failed (${files.length} checked)`);
  process.exit(1);
}

console.log(`[syntax-check] ${files.length} files ok`);
