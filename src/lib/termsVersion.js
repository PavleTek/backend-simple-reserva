/** Versión publicada en simplereserva.com/terminos (última actualización). */
const CURRENT_TERMS_VERSION = '2026-07-04';

/** Fecha de publicación de la versión vigente (UTC). */
const CURRENT_TERMS_PUBLISHED_AT = new Date('2026-07-04T04:00:00.000Z');

/**
 * Versión de T&C aplicable a una fecha de registro (para backfill).
 * Antes del 4-jul-2026 usamos slug pre-publicación documentado.
 */
function resolveTermsVersionForDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return CURRENT_TERMS_VERSION;
  if (d < CURRENT_TERMS_PUBLISHED_AT) return '2026-06-30';
  return CURRENT_TERMS_VERSION;
}

module.exports = {
  CURRENT_TERMS_VERSION,
  CURRENT_TERMS_PUBLISHED_AT,
  resolveTermsVersionForDate,
};
