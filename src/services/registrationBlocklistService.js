/**
 * Blocklist de registro/acceso (emails e IPs). Configurable vía env, separado por comas.
 * Uso: prevenir re-registros tras cuentas terminadas por incumplimiento.
 */
function parseCsvEnv(name) {
  const raw = process.env[name];
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

function isEmailBlocked(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const blocked = parseCsvEnv('BLOCKED_REGISTRATION_EMAILS').map(normalizeEmail);
  return blocked.includes(normalized);
}

function isIpBlocked(ip) {
  if (!ip) return false;
  const blocked = parseCsvEnv('BLOCKED_REGISTRATION_IPS');
  return blocked.includes(ip.trim());
}

function isRegistrationBlocked({ email, ip }) {
  return isEmailBlocked(email) || isIpBlocked(ip);
}

module.exports = {
  getClientIp,
  isEmailBlocked,
  isIpBlocked,
  isRegistrationBlocked,
};
