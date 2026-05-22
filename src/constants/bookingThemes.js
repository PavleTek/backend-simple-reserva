/** Allowed booking page appearance palette ids (keep in sync with frontends bookingThemes.ts). */
const VALID_BOOKING_THEME_IDS = [
  'crema-calida',
  'terracota',
  'lavanda-clara',
  'marfil-lino',
  'vino-oscuro',
  'verde-bosque',
  'azul-medianoche',
  'carbon',
];

const DEFAULT_BOOKING_THEME_ID = 'crema-calida';

function isValidBookingThemeId(id) {
  return typeof id === 'string' && VALID_BOOKING_THEME_IDS.includes(id);
}

module.exports = {
  VALID_BOOKING_THEME_IDS,
  DEFAULT_BOOKING_THEME_ID,
  isValidBookingThemeId,
};
