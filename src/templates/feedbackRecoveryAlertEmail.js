'use strict';

const { escapeHtml } = require('./reservationConfirmationEmail');

/**
 * @param {object} options
 */
function buildFeedbackRecoveryAlertHtml(options) {
  const {
    restaurantName,
    customerName,
    overallScore,
    comment,
    severity,
    panelUrl,
  } = options;

  const safeRestaurant = escapeHtml(restaurantName);
  const safeCustomer = escapeHtml(customerName);
  const safeComment = escapeHtml(comment || '(sin comentario)');
  const safePanel = escapeHtml(panelUrl);
  const safeSeverity = escapeHtml(severity);

  return `<!DOCTYPE html>
<html lang="es-CL">
<head><meta charset="utf-8"><title>Alerta de experiencia</title></head>
<body style="font-family:Inter,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1c1b17;padding:24px;">
  <h2 style="color:#6e2330;margin:0 0 16px 0;">Alerta recovery — ${safeRestaurant}</h2>
  <p><strong>Cliente:</strong> ${safeCustomer}</p>
  <p><strong>Puntuación:</strong> ${overallScore}/5</p>
  <p><strong>Severidad:</strong> ${safeSeverity}</p>
  <p><strong>Comentario:</strong><br/>${safeComment}</p>
  <p style="margin-top:24px;"><a href="${safePanel}" style="color:#8b2d3a;font-weight:600;">Ver en el panel de Experiencia</a></p>
</body>
</html>`;
}

module.exports = { buildFeedbackRecoveryAlertHtml };
