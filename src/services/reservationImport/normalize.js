'use strict';

const { DateTime } = require('luxon');
const { STATUS_MAP } = require('./constants');

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : digits;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { value: null, invalid: true };
  return { value: v, invalid: false };
}

function parseDateStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = DateTime.fromFormat(s, 'dd/MM/yyyy');
  if (dt.isValid) return dt.toFormat('yyyy-MM-dd');
  const dt2 = DateTime.fromISO(s);
  if (dt2.isValid) return dt2.toFormat('yyyy-MM-dd');
  return null;
}

function parseTimeStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace('.', ':');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = m[1].padStart(2, '0');
  const mm = m[2];
  return `${hh}:${mm}`;
}

function mapStatus(raw) {
  if (!raw) return 'confirmed';
  const key = String(raw).trim().toLowerCase();
  return STATUS_MAP[key] || null;
}

function parsePartySize(raw) {
  const n = parseInt(String(raw || '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function durationFromEnd(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  parseDateStr,
  parseTimeStr,
  mapStatus,
  parsePartySize,
  durationFromEnd,
};
