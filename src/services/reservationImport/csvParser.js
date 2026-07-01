'use strict';

const { parse } = require('csv-parse/sync');

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return records;
}

function detectHeaders(rawHeaders) {
  const { HEADER_ALIASES } = require('./constants');
  const normalized = rawHeaders.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasNorms = aliases.map(normalizeHeader);
    const match = normalized.find((h) => aliasNorms.includes(h.norm));
    if (match) mapping[field] = match.raw;
  }

  return mapping;
}

function applyColumnMapping(record, columnMapping) {
  const out = {};
  for (const [field, header] of Object.entries(columnMapping || {})) {
    if (!header) continue;
    out[field] = record[header] ?? '';
  }
  return out;
}

module.exports = {
  normalizeHeader,
  parseCsvBuffer,
  detectHeaders,
  applyColumnMapping,
};
