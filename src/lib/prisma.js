const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');
const { getPerfContext } = require('./perfContext');

/**
 * Instrumentación opcional de queries, activable con PERF_LOG=1 (ver
 * middleware/perfLog.js). Desactivada (default), se exporta el PrismaClient
 * tal cual, sin envoltura — cero overhead ni cambio de comportamiento.
 *
 * Usa un client extension (no `$on('query')`): el evento 'query' de Prisma
 * se emite fuera de la cadena de promesas del request (vía el query engine)
 * y no preserva el AsyncLocalStorage del request en curso. El extension en
 * cambio envuelve la llamada en el mismo call-site, así que sí ve el
 * contexto correcto y permite atribuir cada query a su request.
 *
 * No se loguean argumentos de las queries (pueden incluir PII como nombre/
 * teléfono/email de comensal): solo modelo + operación (p.ej.
 * "Reservation.findMany") y duración.
 */
const basePrisma = new PrismaClient();

const PERF_LOG_ENABLED = process.env.PERF_LOG === '1';
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS || 200);

function recordQuery(model, operation, startedAt) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const ctx = getPerfContext();
  if (ctx) {
    ctx.queryCount += 1;
    ctx.queryTimeMs += durationMs;
  }
  if (durationMs >= SLOW_QUERY_MS) {
    logger.warn(
      { durationMs: Math.round(durationMs * 10) / 10, query: `${model ?? '$raw'}.${operation}`, route: ctx?.route },
      'slow query'
    );
  }
}

const prisma = PERF_LOG_ENABLED
  ? basePrisma.$extends({
      query: {
        $allOperations({ operation, model, args, query }) {
          const startedAt = process.hrtime.bigint();
          return query(args).then(
            (result) => {
              recordQuery(model, operation, startedAt);
              return result;
            },
            (err) => {
              recordQuery(model, operation, startedAt);
              throw err;
            }
          );
        },
      },
    })
  : basePrisma;

module.exports = prisma;
