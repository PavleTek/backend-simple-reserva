/**
 * Política mínima de contraseñas para cuentas SimpleReserva.
 * Alineado con validación en front (registro / cambio de contraseña).
 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * @param {unknown} password
 * @returns {string | null} mensaje de error en español, o null si es válida
 */
function getPasswordPolicyError(password) {
  if (password == null || typeof password !== 'string') {
    return 'La contraseña es obligatoria';
  }
  const trimmed = password.trim();
  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `La contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres`;
  }
  return null;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  getPasswordPolicyError,
};
