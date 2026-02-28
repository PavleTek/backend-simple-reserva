const errorHandler = (err, req, res, _next) => {
  console.error('Error:', err.message);

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

  res.status(500).json({ error: 'Error interno del servidor' });
};

module.exports = errorHandler;
