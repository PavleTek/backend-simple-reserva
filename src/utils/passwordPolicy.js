/**
 * Política mínima de contraseñas para cuentas SimpleReserva.
 * Alineado con validación en front (registro / cambio de contraseña).
 */
const MIN_PASSWORD_LENGTH = 1;
const MAX_PASSWORD_LENGTH = 128;

/**
 * @param {unknown} password
 * @returns {string | null} mensaje de error en español, o null si es válida
 */
function getPasswordPolicyError(password) {
  if (password == null || typeof password !== 'string' || password.length === 0) {
    return 'La contraseña es obligatoria';
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
