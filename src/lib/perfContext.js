'use strict';

/**
 * Contexto de performance por request, usando AsyncLocalStorage.
 *
 * Permite que `prisma.js` sume queries/tiempo de DB al request HTTP en curso
 * sin acoplar el cliente Prisma a Express. Solo se usa cuando PERF_LOG=1
 * (ver middleware/perfLog.js); si no está activo, `getPerfContext()` siempre
 * retorna undefined y no hay overhead.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const perfContextStorage = new AsyncLocalStorage();

function runWithPerfContext(context, fn) {
  return perfContextStorage.run(context, fn);
}

function getPerfContext() {
  return perfContextStorage.getStore();
}

module.exports = { runWithPerfContext, getPerfContext };
