'use strict';

const SENTINEL_PHONES = new Set(['—', '–', '-', '−']);

function isSentinelPhone(value) {
  if (value == null) return true;
  const trimmed = String(value).trim();
  return trimmed === '' || SENTINEL_PHONES.has(trimmed);
}

/**
 * Normaliza a E.164. Chile por defecto (9 dígitos / 56…).
 * Si defaultCountry no es CL, no inventa +56: solo acepta +E.164 o 10–15 dígitos.
 * Centinelas (—, -) y basura → null.
 */
function normalizePhone(phone, { defaultCountry = 'CL' } = {}) {
  if (phone == null || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (isSentinelPhone(trimmed)) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    return null;
  }

  const cleaned = trimmed.replace(/\D/g, '');
  if (!cleaned) return null;

  if (defaultCountry === 'CL') {
    if (cleaned.startsWith('56') && cleaned.length >= 9) return `+${cleaned}`;
    if (cleaned.length === 9 && cleaned.startsWith('9')) return `+56${cleaned}`;
    if (cleaned.length === 8) return `+569${cleaned}`;
    return null;
  }

  if (cleaned.length >= 10 && cleaned.length <= 15) return `+${cleaned}`;
  return null;
}

module.exports = {
  normalizePhone,
  isSentinelPhone,
};
