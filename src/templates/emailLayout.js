'use strict';

const { resolveEmailTheme } = require('../constants/bookingThemes');

/** Colors aligned with user-front `docs/STYLING.md` (semantic + primary wine). */
const COLORS = {
  pageBg: '#faf9f6',
  cardBg: '#fdfcfa',
  border: '#e8e7e3',
  textPrimary: '#1c1b17',
  textSecondary: '#535146',
  textMuted: '#8a8675',
  primary600: '#8b2d3a',
  primary700: '#6e2330',
};

const SR_GUEST_DEFAULT_COLORS = {
  ...COLORS,
  nestedBg: '#f5f4f0',
  headerGradientFrom: '#faf0f1',
  primaryTextOn: '#ffffff',
  isDark: false,
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Absolute HTTPS SimpleReserva wordmark, or null if unsafe for email clients.
 * @param {string} baseUrl
 * @param {{ variant?: 'default' | 'white' }} [options]
 * @returns {string|null}
 */
function resolveLogoImageUrl(baseUrl, options = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  const variant = options?.variant === 'white' ? 'white' : 'default';
  const path = variant === 'white' ? '/logo-full-white-480w.png' : '/logo-full-480w.png';
  try {
    const logoU = new URL(path, baseUrl);
    if (logoU.protocol !== 'https:') return null;
    const h = logoU.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return null;
    return logoU.toString();
  } catch {
    return null;
  }
}

/**
 * Absolute HTTPS restaurant logo URL, or null if missing/unsafe.
 * @param {unknown} logoUrl
 * @returns {string|null}
 */
function resolveRestaurantLogoImageUrl(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  try {
    const u = new URL(logoUrl.trim());
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Guest emails: restaurant theme only when a valid restaurant logo exists.
 * Without logo → SimpleReserva default colors (current template look).
 * @param {{ restaurantLogoUrl?: string|null, appearanceTheme?: string|null }} opts
 */
function resolveGuestEmailPresentation({ restaurantLogoUrl = null, appearanceTheme = null } = {}) {
  const validLogo = resolveRestaurantLogoImageUrl(restaurantLogoUrl);
  if (!validLogo) {
    return {
      branded: false,
      restaurantLogoUrl: null,
      colors: { ...SR_GUEST_DEFAULT_COLORS },
    };
  }
  const theme = resolveEmailTheme(appearanceTheme);
  return {
    branded: true,
    restaurantLogoUrl: validLogo,
    colors: {
      pageBg: theme.pageBg,
      cardBg: theme.cardBg,
      nestedBg: theme.nestedBg,
      border: theme.border,
      textPrimary: theme.textPrimary,
      textSecondary: theme.textSecondary,
      textMuted: theme.textMuted,
      primary600: theme.primary,
      primary700: theme.primaryHover,
      primaryTextOn: theme.primaryTextOn,
      headerGradientFrom: theme.headerGradientFrom,
      isDark: theme.isDark,
    },
  };
}

/**
 * Header logo row: restaurant mark when branded, else SimpleReserva wordmark/text.
 * @param {{
 *   restaurantLogoUrl: string|null,
 *   restaurantName: string,
 *   assetBaseUrl?: string,
 *   colors: typeof SR_GUEST_DEFAULT_COLORS,
 * }} opts
 */
function buildGuestEmailLogoBlock({
  restaurantLogoUrl,
  restaurantName,
  assetBaseUrl = '',
  colors,
}) {
  if (restaurantLogoUrl) {
    return `<tr><td align="center" style="padding:0 0 20px 0;background-color:${colors.cardBg};"><img src="${escapeHtml(restaurantLogoUrl)}" alt="${escapeHtml(restaurantName)}" width="160" style="display:block;width:160px;height:auto;max-width:160px;border:0;outline:none;text-decoration:none;margin:0 auto;" /></td></tr>`;
  }
  const variant = colors.isDark ? 'white' : 'default';
  const logoUrl = resolveLogoImageUrl(assetBaseUrl, { variant });
  if (logoUrl) {
    return `<tr><td align="center" style="padding:0 0 20px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="200" style="display:block;width:200px;height:auto;max-width:200px;border:0;outline:none;text-decoration:none;" /></td></tr>`;
  }
  return `<tr><td align="center" style="padding:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${colors.primary700};letter-spacing:-0.02em;">SimpleReserva</td></tr>`;
}

/**
 * Pie guest: texto siempre; wordmark SR (etiqueta) solo en modo branded.
 * @param {string} restaurantName
 * @param {{
 *   border?: string,
 *   textMuted?: string,
 *   padding?: string,
 *   showBrandMark?: boolean,
 *   isDark?: boolean,
 *   assetBaseUrl?: string,
 *   primary700?: string,
 * }} [style]
 */
function buildSimpleReservaEmailFooter(restaurantName, style = {}) {
  const year = new Date().getFullYear();
  const safeRestaurant = escapeHtml(restaurantName);
  const border = style.border ?? '#e8e7e3';
  const textMuted = style.textMuted ?? '#8a8675';
  const padding = style.padding ?? '16px 28px 24px';
  const primary700 = style.primary700 ?? COLORS.primary700;

  let brandMarkHtml = '';
  if (style.showBrandMark) {
    const variant = style.isDark ? 'white' : 'default';
    const logoUrl = resolveLogoImageUrl(style.assetBaseUrl || '', { variant });
    if (logoUrl) {
      brandMarkHtml = `<p style="margin:0 0 12px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="120" style="display:inline-block;width:120px;height:auto;max-width:120px;border:0;outline:none;text-decoration:none;" /></p>`;
    } else {
      brandMarkHtml = `<p style="margin:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;color:${primary700};">SimpleReserva</p>`;
    }
  }

  return `<tr>
    <td style="padding:${padding};border-top:1px solid ${border};font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${textMuted};text-align:center;">
      ${brandMarkHtml}
      <p style="margin:0 0 6px 0;">Enviado por SimpleReserva para ${safeRestaurant}.</p>
      <p style="margin:0;">&copy; ${year} SimpleReserva</p>
    </td>
  </tr>`;
}

/**
 * @param {Object} opts
 * @param {string} opts.assetBaseUrl
 * @param {string} opts.eyebrow
 * @param {string} opts.headline
 * @param {string} opts.preheader
 * @returns {{ safePreheader: string, headerHtml: string }}
 */
function buildEmailHeaderBlock({ assetBaseUrl, eyebrow, headline, preheader }) {
  const safePreheader = escapeHtml(preheader);
  const logoUrl = resolveLogoImageUrl(assetBaseUrl);
  const logoBlock = logoUrl
    ? `<tr><td align="center" style="padding:0 0 20px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="200" style="display:block;width:200px;height:auto;max-width:200px;border:0;outline:none;text-decoration:none;" /></td></tr>`
    : `<tr><td align="center" style="padding:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${COLORS.primary700};letter-spacing:-0.02em;">SimpleReserva</td></tr>`;

  return {
    safePreheader,
    headerHtml: `<tr>
            <td style="padding:28px 32px 8px 32px;background:linear-gradient(180deg,#faf0f1 0%,${COLORS.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:4px 0 0 0;">
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.primary600};">${escapeHtml(eyebrow)}</p>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${COLORS.textPrimary};line-height:1.2;">${escapeHtml(headline)}</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`,
  };
}

/**
 * @param {number} [year]
 * @returns {string}
 */
function buildEmailFooter(year = new Date().getFullYear()) {
  return `<tr>
            <td style="padding:20px 32px 28px 32px;border-top:1px solid ${COLORS.border};font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${COLORS.textMuted};text-align:center;">
              <p style="margin:0 0 6px 0;">SimpleReserva &mdash; Sistema de reservas para restaurantes.</p>
              <p style="margin:0;">&copy; ${year} SimpleReserva</p>
            </td>
          </tr>`;
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.preheader
 * @param {string} opts.headerHtml
 * @param {string} opts.bodyHtml
 * @param {string} opts.footerHtml
 * @param {string} opts.safePreheader
 * @returns {string}
 */
function wrapEmailDocument({ title, preheader, headerHtml, bodyHtml, footerHtml, safePreheader }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style type="text/css">
    body { margin:0 !important; padding:0 !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${COLORS.primary600}; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.pageBg};">
  <span style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.pageBg};max-height:0;max-width:0;opacity:0;overflow:hidden;">${safePreheader}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${COLORS.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:${COLORS.cardBg};border-radius:16px;border:1px solid ${COLORS.border};overflow:hidden;box-shadow:0 4px 12px rgba(28,27,23,0.06);">
          ${headerHtml}
          <tr>
            <td style="padding:8px 32px 28px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${COLORS.textPrimary};">
              ${bodyHtml}
            </td>
          </tr>
          ${footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  COLORS,
  escapeHtml,
  resolveLogoImageUrl,
  resolveRestaurantLogoImageUrl,
  resolveGuestEmailPresentation,
  buildGuestEmailLogoBlock,
  buildSimpleReservaEmailFooter,
  buildEmailHeaderBlock,
  buildEmailFooter,
  wrapEmailDocument,
};
