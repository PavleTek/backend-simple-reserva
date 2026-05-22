'use strict';

const crypto = require('crypto');

/**
 * @param {string|null|undefined} email
 * @returns {string|null}
 */
function normalizeCustomerEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {string} email
 * @returns {string}
 */
function hashEmail(email) {
  const normalized = normalizeCustomerEmail(email);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { normalizeCustomerEmail, hashEmail };
