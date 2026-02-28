const errorHandler = (err, req, res, _next) => {
  console.error('Error:', err.message);

  if (err.isOperational) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err.code === 'P2002') {
    res.status(409).json({ error: 'A record with this value already exists' });
    return;
  }

  if (err.code === 'P2025') {
    res.status(404).json({ error: 'Record not found' });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
};

module.exports = errorHandler;
