class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

/**
 * Conflicto de mesa vinculada resoluble: además del mensaje, lleva el detalle de qué
 * mesas chocan y qué se puede hacer (mover la reserva que bloquea, o sustituir la mesa)
 * para que el cliente pueda ofrecer una resolución en vez de un error genérico.
 */
class TableConflictError extends AppError {
  constructor(message, conflicts = []) {
    super(message, 409);
    this.conflicts = conflicts;
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  TableConflictError
};
