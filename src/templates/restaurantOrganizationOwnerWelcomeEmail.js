'use strict';

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
 * @param {string} baseUrl
 * @returns {string|null} Absolute HTTPS logo URL, or null if unsafe for email clients
 */
function resolveLogoImageUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    const logoU = new URL('/logo-full-480w.png', baseUrl);
    if (logoU.protocol !== 'https:') return null;
    const h = logoU.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return null;
    return logoU.toString();
  } catch {
    return null;
  }
}

/**
 * Builds a welcome HTML email for new restaurant organization owners.
 * @param {Object} options
 * @param {string} options.ownerName - Full name (or email fallback) of the new owner
 * @param {string} options.panelUrl - URL to the restaurant management portal login
 * @param {string} options.contactEmail - Support email address
 * @param {string} options.whatsappDisplay - Human-readable WhatsApp number (e.g. "+56 9 5102 0295")
 * @param {string} options.whatsappHref - WhatsApp chat URL (e.g. "https://wa.me/56951020295")
 * @param {string} [options.assetBaseUrl] - Origin for optional wordmark image (HTTPS non-local only)
 * @returns {string} HTML content
 */
function buildOrganizationOwnerWelcomeHtml(options) {
  const {
    ownerName,
    panelUrl,
    contactEmail,
    whatsappDisplay,
    whatsappHref,
    assetBaseUrl = '',
  } = options;

  const safeOwner = escapeHtml(ownerName);
  const safePanelUrl = escapeHtml(panelUrl);
  const safeContactEmail = escapeHtml(contactEmail);
  const safeWhatsappDisplay = escapeHtml(whatsappDisplay);
  const safeWhatsappHref = escapeHtml(whatsappHref);
  const safeMailtoContact = escapeHtml(`mailto:${contactEmail}`);
  const year = new Date().getFullYear();

  const preheader = `Bienvenido a SimpleReserva, ${ownerName}. Tu cuenta está lista. Comienza a gestionar tus reservas.`;
  const safePreheader = escapeHtml(preheader);

  const logoUrl = resolveLogoImageUrl(assetBaseUrl);
  const logoBlock = logoUrl
    ? `<tr><td align="center" style="padding:0 0 20px 0;"><img src="${escapeHtml(logoUrl)}" alt="SimpleReserva" width="200" style="display:block;width:200px;height:auto;max-width:200px;border:0;outline:none;text-decoration:none;" /></td></tr>`
    : `<tr><td align="center" style="padding:0 0 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${COLORS.primary700};letter-spacing:-0.02em;">SimpleReserva</td></tr>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Bienvenido a SimpleReserva</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
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
          <tr>
            <td style="padding:28px 32px 8px 32px;background:linear-gradient(180deg,#faf0f1 0%,${COLORS.cardBg} 100%);">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:4px 0 0 0;">
                    <p style="margin:0;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.primary600};">Cuenta creada</p>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${COLORS.textPrimary};line-height:1.2;">¡Bienvenido a SimpleReserva!</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${COLORS.textPrimary};">
              <p style="margin:0 0 16px 0;">Hola <strong style="color:${COLORS.textPrimary};">${safeOwner}</strong>,</p>
              <p style="margin:0 0 20px 0;color:${COLORS.textSecondary};">
                Nos alegra tenerte con nosotros. Tu cuenta en SimpleReserva está lista y puedes comenzar a
                gestionar las reservas de tu local desde tu panel de administración.
              </p>
              <p style="margin:0 0 28px 0;color:${COLORS.textSecondary};">
                Desde el panel podrás configurar tus horarios, mesas y zonas, personalizar la experiencia de
                reserva para tus clientes, y ver el historial de reservas en tiempo real.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center" style="padding:0;">
                    <a href="${safePanelUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff !important;text-decoration:none;border-radius:12px;background-color:${COLORS.primary600};box-shadow:0 2px 8px rgba(139,45,58,0.25);">Ir a mi panel de reservas</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;color:${COLORS.textSecondary};text-align:center;">
                ¿Tienes preguntas? Escríbenos, estamos para ayudarte.
              </p>
              <p style="margin:0;font-size:14px;line-height:1.5;color:${COLORS.textSecondary};text-align:center;">
                También puedes <a href="${safeWhatsappHref}" style="color:${COLORS.primary600};font-weight:600;">escribirnos por WhatsApp al ${safeWhatsappDisplay}</a> o por
                <a href="${safeMailtoContact}" style="color:${COLORS.primary600};font-weight:600;">${safeContactEmail}</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px 32px;border-top:1px solid ${COLORS.border};font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${COLORS.textMuted};text-align:center;">
              <p style="margin:0 0 6px 0;">SimpleReserva &mdash; Sistema de reservas para restaurantes.</p>
              <p style="margin:0;">&copy; ${year} SimpleReserva</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  buildOrganizationOwnerWelcomeHtml,
  escapeHtml,
  resolveLogoImageUrl,
};
