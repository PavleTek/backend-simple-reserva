'use strict';

/**
 * Middleware de instrumentación de performance por request.
 *
 * Activado solo con PERF_LOG=1 (default: desactivado, cero overhead — este
 * middleware se limita a llamar next() inmediatamente). Pensado para medir en
 * staging o localmente con datasets grandes, no para producción.
 *
 * Loguea por request: método, path (sin query string, para no exponer datos
 * como `search` de clientes), status, duración, cantidad de queries Prisma y
 * tiempo acumulado en DB. No loguea body, headers ni params de queries.
 *
 * También expone `X-Perf-Query-Count` / `X-Perf-Query-Time-Ms` en la
 * respuesta (solo con PERF_LOG=1) para que scripts de benchmark puedan leer
 * el costo en DB de cada request sin parsear logs.
 *
 * Fácil de remover: quitar la línea `app.use(perfLog)` en index.js y borrar
 * este archivo + lib/perfContext.js; prisma.js vuelve a su comportamiento
 * default si PERF_LOG no está seteado.
 */
const logger = require('../lib/logger');
const { runWithPerfContext } = require('../lib/perfContext');

const PERF_LOG_ENABLED = process.env.PERF_LOG === '1';

function perfLog(req, res, next) {
  if (!PERF_LOG_ENABLED) return next();

  const context = { queryCount: 0, queryTimeMs: 0, route: req.path };
  const startedAt = process.hrtime.bigint();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.set('X-Perf-Query-Count', String(context.queryCount));
    res.set('X-Perf-Query-Time-Ms', context.queryTimeMs.toFixed(1));
    return originalJson(body);
  };

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        queryCount: context.queryCount,
        queryTimeMs: Math.round(context.queryTimeMs * 100) / 100,
        bytes: Number(res.get('content-length')) || undefined,
      },
      'perf'
    );
  });

  runWithPerfContext(context, next);
}

module.exports = perfLog;
