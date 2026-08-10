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

/**
 * Email-safe hex tokens (no CSS vars / rgba). Keep in sync with
 * user-front-simple-reserva/src/lib/bookingThemes.ts swatch + vars.
 * @typedef {{
 *   id: string,
 *   isDark: boolean,
 *   pageBg: string,
 *   cardBg: string,
 *   nestedBg: string,
 *   border: string,
 *   textPrimary: string,
 *   textSecondary: string,
 *   textMuted: string,
 *   primary: string,
 *   primaryHover: string,
 *   primaryTextOn: string,
 *   headerGradientFrom: string,
 * }} EmailThemeTokens
 */

/** @type {Record<string, EmailThemeTokens>} */
const EMAIL_THEME_BY_ID = {
  'crema-calida': {
    id: 'crema-calida',
    isDark: false,
    pageBg: '#faf9f6',
    cardBg: '#fdfcfa',
    nestedBg: '#f5f4f0',
    border: '#e8e7e3',
    textPrimary: '#1c1b17',
    textSecondary: '#535146',
    textMuted: '#8a8675',
    primary: '#8b2d3a',
    primaryHover: '#6e2330',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#faf0f1',
  },
  terracota: {
    id: 'terracota',
    isDark: false,
    pageBg: '#faf6f2',
    cardBg: '#fdf9f5',
    nestedBg: '#f5efe8',
    border: '#e8ddd4',
    textPrimary: '#2a221c',
    textSecondary: '#5c4a3a',
    textMuted: '#8a7560',
    primary: '#b85c38',
    primaryHover: '#9a4a2c',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#f7ebe4',
  },
  'lavanda-clara': {
    id: 'lavanda-clara',
    isDark: false,
    pageBg: '#f8f6fc',
    cardBg: '#fdfcff',
    nestedBg: '#f0ecf8',
    border: '#e4dcec',
    textPrimary: '#1f1a28',
    textSecondary: '#4a4258',
    textMuted: '#7a7088',
    primary: '#6b4c9a',
    primaryHover: '#563d7d',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#f0ebf7',
  },
  'marfil-lino': {
    id: 'marfil-lino',
    isDark: false,
    pageBg: '#f9faf8',
    cardBg: '#fcfdfb',
    nestedBg: '#f0f3f1',
    border: '#dde4e0',
    textPrimary: '#1a2228',
    textSecondary: '#3d4f58',
    textMuted: '#6a7a82',
    primary: '#3d5a6e',
    primaryHover: '#2f4758',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#e8eef1',
  },
  'vino-oscuro': {
    id: 'vino-oscuro',
    isDark: true,
    pageBg: '#0c0b0a',
    cardBg: '#1a1916',
    nestedBg: '#2c2a24',
    border: '#2c2a24',
    textPrimary: '#f4f3ef',
    textSecondary: '#a8a59a',
    textMuted: '#8a8675',
    primary: '#b84856',
    primaryHover: '#d4737e',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#1a1916',
  },
  'verde-bosque': {
    id: 'verde-bosque',
    isDark: true,
    pageBg: '#0a1210',
    cardBg: '#142420',
    nestedBg: '#223830',
    border: '#223830',
    textPrimary: '#eef5f1',
    textSecondary: '#a8bdb2',
    textMuted: '#7a9488',
    primary: '#3d8b6e',
    primaryHover: '#52a383',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#142420',
  },
  'azul-medianoche': {
    id: 'azul-medianoche',
    isDark: true,
    pageBg: '#0a0e14',
    cardBg: '#121a28',
    nestedBg: '#1e2a40',
    border: '#1e2a40',
    textPrimary: '#eef2f8',
    textSecondary: '#a8b4c8',
    textMuted: '#7a8aa0',
    primary: '#4a7ab8',
    primaryHover: '#5f92d4',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#121a28',
  },
  carbon: {
    id: 'carbon',
    isDark: true,
    pageBg: '#111111',
    cardBg: '#1c1c1c',
    nestedBg: '#2e2e2e',
    border: '#2e2e2e',
    textPrimary: '#f0f0f0',
    textSecondary: '#a0a0a0',
    textMuted: '#707070',
    primary: '#8a8a8a',
    primaryHover: '#a0a0a0',
    primaryTextOn: '#ffffff',
    headerGradientFrom: '#1c1c1c',
  },
};

function isValidBookingThemeId(id) {
  return typeof id === 'string' && VALID_BOOKING_THEME_IDS.includes(id);
}

/**
 * @param {string|null|undefined} appearanceThemeId
 * @returns {EmailThemeTokens}
 */
function resolveEmailTheme(appearanceThemeId) {
  if (appearanceThemeId && EMAIL_THEME_BY_ID[appearanceThemeId]) {
    return EMAIL_THEME_BY_ID[appearanceThemeId];
  }
  return EMAIL_THEME_BY_ID[DEFAULT_BOOKING_THEME_ID];
}

module.exports = {
  VALID_BOOKING_THEME_IDS,
  DEFAULT_BOOKING_THEME_ID,
  isValidBookingThemeId,
  resolveEmailTheme,
};
