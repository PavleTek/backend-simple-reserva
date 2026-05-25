const { ValidationError } = require('./errors');

const MAX_URL_LENGTH = 2048;
const BLOCKED_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:'];

function normalizeExternalUrl(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw new ValidationError('La URL es obligatoria');
  }
  let trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError('La URL es obligatoria');
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new ValidationError('La URL es demasiado larga');
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError('La URL no es válida');
  }
  const proto = `${parsed.protocol}`.toLowerCase();
  if (!['http:', 'https:'].includes(proto)) {
    throw new ValidationError('Solo se permiten enlaces http o https');
  }
  for (const blocked of BLOCKED_PROTOCOLS) {
    if (trimmed.toLowerCase().startsWith(blocked)) {
      throw new ValidationError('La URL no es válida');
    }
  }
  return parsed.href;
}

const MIN_LABEL_LENGTH = 2;
const MAX_LABEL_LENGTH = 80;

function validateMenuLabel(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw new ValidationError('El nombre de la carta es obligatorio');
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_LABEL_LENGTH) {
    throw new ValidationError(`El nombre debe tener al menos ${MIN_LABEL_LENGTH} caracteres`);
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new ValidationError(`El nombre no puede superar ${MAX_LABEL_LENGTH} caracteres`);
  }
  return trimmed;
}

const LEGACY_MENU_TYPES = ['main', 'drinks', 'dessert'];

const LEGACY_LABEL_BY_MENU_TYPE = {
  main: 'Menú Principal',
  drinks: 'Carta de Bebidas',
  dessert: 'Carta de Postres',
};

function legacyLabelForMenuType(menuType) {
  return LEGACY_LABEL_BY_MENU_TYPE[menuType] || 'Menú';
}

function legacySortOrderForMenuType(menuType) {
  if (menuType === 'main') return 0;
  if (menuType === 'drinks') return 1;
  if (menuType === 'dessert') return 2;
  return 0;
}

module.exports = {
  normalizeExternalUrl,
  validateMenuLabel,
  LEGACY_MENU_TYPES,
  legacyLabelForMenuType,
  legacySortOrderForMenuType,
  MIN_LABEL_LENGTH,
  MAX_LABEL_LENGTH,
};
