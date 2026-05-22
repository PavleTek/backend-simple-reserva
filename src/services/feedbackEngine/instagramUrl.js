'use strict';

/**
 * Convierte handle o URL parcial de Instagram en un enlace absoluto válido.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeInstagramUrl(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  if (s.startsWith('@')) {
    s = s.slice(1).trim();
    if (!s) return null;
  }

  if (!/^https?:\/\//i.test(s)) {
    const lower = s.toLowerCase();
    if (lower.startsWith('instagram.com/') || lower.startsWith('www.instagram.com/')) {
      s = `https://${s}`;
    } else if (/^[a-zA-Z0-9._]{1,30}$/.test(s)) {
      return `https://www.instagram.com/${s}/`;
    } else if (lower.includes('instagram.com')) {
      s = `https://${s.replace(/^www\./i, '')}`;
    } else {
      return null;
    }
  }

  try {
    const url = new URL(s);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'instagram.com') return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const username = segments[0];
    if (!username || !/^[a-zA-Z0-9._]+$/.test(username)) return null;

    return `https://www.instagram.com/${username}/`;
  } catch {
    return null;
  }
}

module.exports = { normalizeInstagramUrl };
