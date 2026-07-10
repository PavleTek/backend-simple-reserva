'use strict';

/**
 * Configuración compartida por seed-perf.js, cleanup-perf.js y benchmark.js.
 *
 * Todos los datos viven bajo un único usuario/organización dedicados,
 * claramente marcados con el prefijo "[PERF]" y un email @simplereserva.local,
 * para no mezclarse nunca con datos reales y poder limpiarse por completo con
 * cleanup-perf.js.
 */

const TIMEZONE = 'America/Santiago';
const OWNER_EMAIL = 'perf-test-owner@simplereserva.local';
const ORG_NAME = '[PERF] Carga de prueba';

/**
 * Un escenario por cada tamaño de local que queremos poder comparar.
 * `turnos: true` usa scheduleMode "service_periods" (almuerzo + cena) en vez
 * de horario continuo, para ejercitar ese camino con el local más grande.
 */
const SCENARIOS = [
  { tableCount: 20, slug: 'perf-test-20-mesas', name: '[PERF] 20 mesas', historicalCount: 300, turnos: false },
  { tableCount: 40, slug: 'perf-test-40-mesas', name: '[PERF] 40 mesas', historicalCount: 800, turnos: false },
  { tableCount: 80, slug: 'perf-test-80-mesas', name: '[PERF] 80 mesas', historicalCount: 2500, turnos: false },
  { tableCount: 120, slug: 'perf-test-120-mesas', name: '[PERF] 120 mesas (100+)', historicalCount: 6000, turnos: true },
];

/** Días (desde hoy) con reservas densas, para poder cambiar de fecha en el benchmark. */
const FUTURE_DENSE_DAYS = 7;

/** YYYY-MM-DD a partir de hoy (UTC) + offset en días (puede ser negativo). */
function dateStrOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  TIMEZONE,
  OWNER_EMAIL,
  ORG_NAME,
  SCENARIOS,
  FUTURE_DENSE_DAYS,
  dateStrOffset,
};
