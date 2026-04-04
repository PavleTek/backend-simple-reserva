/**
 * Logger estructurado (JSON en stdout). Nivel por LOG_LEVEL o info en prod / debug en dev.
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
});

module.exports = logger;
