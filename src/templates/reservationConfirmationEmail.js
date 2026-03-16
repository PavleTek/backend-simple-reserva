const { formatDateDisplay, formatTime } = require('../utils/dateFormat');

/**
 * Builds a restaurant-specific HTML email template for reservation confirmation.
 * @param {Object} options
 * @param {string} options.restaurantName - Name of the restaurant
 * @param {string} options.customerName - Name of the customer
 * @param {Date|string} options.dateTime - Reservation date/time
 * @param {number} options.partySize - Number of guests
 * @param {string} options.viewUrl - URL to view/cancel the reservation
 * @returns {string} HTML content
 */
function buildReservationConfirmationHtml(options) {
  const { restaurantName, customerName, dateTime, partySize, viewUrl } = options;
  
  const dt = new Date(dateTime);
  const dateStr = formatDateDisplay(dt);
  const timeStr = formatTime(dt);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; mx-auto; padding: 20px; border: 1px solid #eee; border-radius: 10px; margin: 20px auto; }
        .header { text-align: center; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .content { padding: 20px 0; }
        .details { background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .detail-row { display: flex; justify-content: space-between; margin-bottom: 10px; }
        .detail-label { color: #666; font-size: 14px; }
        .detail-value { font-weight: bold; color: #333; }
        .footer { text-align: center; font-size: 12px; color: #999; padding-top: 20px; border-top: 1px solid #eee; }
        .button { display: inline-block; padding: 12px 24px; background-color: #4f46e5; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; }
        .cancel-text { font-size: 13px; color: #666; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin: 0; color: #4f46e5;">¡Reserva Confirmada!</h2>
          <p style="margin: 5px 0 0; color: #666;">Tu mesa en ${restaurantName} está lista.</p>
        </div>
        <div class="content">
          <p>Hola <strong>${customerName}</strong>,</p>
          <p>Gracias por elegir <strong>${restaurantName}</strong>. Tu reserva ha sido procesada con éxito. Aquí tienes los detalles:</p>
          
          <div class="details">
            <div class="detail-row">
              <span class="detail-label">Fecha</span>
              <span class="detail-value">${dateStr}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Hora</span>
              <span class="detail-value">${timeStr}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Comensales</span>
              <span class="detail-value">${partySize} persona(s)</span>
            </div>
          </div>

          <div style="text-align: center;">
            <a href="${viewUrl}" class="button">Ver mi reserva</a>
          </div>

          <p class="cancel-text">
            ¿Necesitas hacer cambios o cancelar? Puedes hacerlo directamente desde el enlace de arriba.
          </p>
        </div>
        <div class="footer">
          <p>Este es un mensaje automático de SimpleReserva para ${restaurantName}.</p>
          <p>&copy; ${new Date().getFullYear()} SimpleReserva</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = {
  buildReservationConfirmationHtml,
};
