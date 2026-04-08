const logger = require('../lib/logger');

const errorHandler = (err, req, res, _next) => {
  logger.error(
    { err: err.message, code: err.code, path: req.path, method: req.method },
    'request error'
  );

  if (err.isOperational) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err.code === 'P2002') {
    res.status(409).json({ error: 'Ya existe un registro con este valor' });
    return;
  }

  if (err.code === 'P2025') {
    res.status(404).json({ error: 'Registro no encontrado' });
    return;
  }

  // Conflicto de transacción (p. ej. aislamiento Serializable) — reintentar suele resolver
  if (err.code === 'P2034') {
    res.status(409).json({
      error:
        'El horario ya no está disponible o hubo un conflicto. Actualiza la página e intenta de nuevo.',
    });
    return;
  }

  res.status(500).json({ error: 'Error interno del servidor' });
};

module.exports = errorHandler;
