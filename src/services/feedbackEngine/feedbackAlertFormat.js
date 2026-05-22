'use strict';

const { formatDateDisplay, formatTime } = require('../../utils/dateFormat');

const ALERT_DETAIL_INCLUDE = {
  feedbackResponse: {
    select: {
      overallScore: true,
      serviceScore: true,
      foodScore: true,
      atmosphereScore: true,
      reservationScore: true,
      comment: true,
      recoveryContactRequested: true,
      recoveryContactEmail: true,
      recoveryContactPhone: true,
      partySize: true,
      dateTime: true,
      respondedAt: true,
      feedbackRequest: {
        select: {
          reservation: {
            select: {
              customerName: true,
              customerEmail: true,
              customerPhone: true,
              dateTime: true,
              partySize: true,
              status: true,
            },
          },
        },
      },
    },
  },
};

const SEVERITY_LABELS = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

function formatVisitLine(reservation, timezone) {
  const dt = reservation?.dateTime;
  if (!dt) return null;
  const date = formatDateDisplay(new Date(dt), timezone || undefined);
  const time = formatTime(new Date(dt), timezone || undefined);
  const party = reservation?.partySize;
  const partyStr = party != null ? ` · ${party} ${party === 1 ? 'persona' : 'personas'}` : '';
  return `${date}, ${time}${partyStr}`;
}

function formatCategoryScores(fr) {
  if (!fr) return null;
  const parts = [];
  if (fr.serviceScore != null) parts.push(`Servicio ${fr.serviceScore}/5`);
  if (fr.foodScore != null) parts.push(`Comida ${fr.foodScore}/5`);
  if (fr.atmosphereScore != null) parts.push(`Ambiente ${fr.atmosphereScore}/5`);
  if (fr.reservationScore != null) parts.push(`Reserva ${fr.reservationScore}/5`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Líneas estructuradas para panel (admin / restaurante).
 */
function buildAlertDetailLines(alert, timezone = null) {
  const fr = alert.feedbackResponse;
  const reservation = fr?.feedbackRequest?.reservation;
  const lines = [];

  const customerName = reservation?.customerName?.trim();
  if (customerName) lines.push({ label: 'Cliente', value: customerName });

  const visit = formatVisitLine(reservation || { dateTime: fr?.dateTime, partySize: fr?.partySize ?? reservation?.partySize }, timezone);
  if (visit) lines.push({ label: 'Visita', value: visit });

  if (reservation?.customerEmail) {
    lines.push({ label: 'Email reserva', value: reservation.customerEmail });
  }
  if (reservation?.customerPhone) {
    lines.push({ label: 'Teléfono', value: reservation.customerPhone });
  }

  if (fr?.overallScore != null) {
    lines.push({ label: 'Puntuación general', value: `${fr.overallScore}/5` });
  }

  const categories = formatCategoryScores(fr);
  if (categories) lines.push({ label: 'Por categoría', value: categories });

  if (fr?.comment?.trim()) {
    lines.push({ label: 'Comentario', value: fr.comment.trim() });
  }

  if (fr?.recoveryContactRequested) {
    const contactEmail = fr.recoveryContactEmail?.trim();
    lines.push({
      label: 'Solicita contacto',
      value: contactEmail || 'Sí (usar email de la reserva)',
      highlight: true,
    });
  } else {
    lines.push({ label: 'Solicita contacto', value: 'No' });
  }

  if (fr?.respondedAt) {
    lines.push({
      label: 'Respondió el',
      value: formatDateDisplay(new Date(fr.respondedAt), timezone || undefined),
    });
  }

  return lines;
}

/**
 * @param {object} params
 */
function buildRecoveryAlertContent({
  customerName,
  overallScore,
  categoryScores = {},
  comment,
  recoveryContactRequested,
  recoveryContactEmail,
  visitDateTime,
  partySize,
  customerEmail,
  customerPhone,
  timezone,
  severity,
}) {
  const name = customerName?.trim() || 'Cliente';
  const title =
    severity === 'high'
      ? `Alerta recovery: ${name}`
      : `Experiencia a mejorar: ${name}`;

  const lines = [];
  lines.push(`Cliente: ${name}`);

  if (visitDateTime) {
    const visit = formatVisitLine({ dateTime: visitDateTime, partySize }, timezone);
    if (visit) lines.push(`Visita: ${visit}`);
  }

  if (customerEmail) lines.push(`Email reserva: ${customerEmail}`);
  if (customerPhone) lines.push(`Teléfono: ${customerPhone}`);

  lines.push(`Puntuación general: ${overallScore}/5`);

  const catLine = formatCategoryScores({
    serviceScore: categoryScores.serviceScore,
    foodScore: categoryScores.foodScore,
    atmosphereScore: categoryScores.atmosphereScore,
    reservationScore: categoryScores.reservationScore,
  });
  if (catLine) lines.push(`Por categoría: ${catLine}`);

  if (comment?.trim()) lines.push(`Comentario: ${comment.trim()}`);

  if (recoveryContactRequested) {
    lines.push(
      `Solicita contacto: sí${recoveryContactEmail ? ` → ${recoveryContactEmail}` : ' (email de la reserva)'}`
    );
  }

  return { title, body: lines.join('\n') };
}

function formatAlertForApi(alert, timezone = null) {
  const details = buildAlertDetailLines(alert, timezone);
  const fr = alert.feedbackResponse;
  const reservation = fr?.feedbackRequest?.reservation;

  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    severityLabel: SEVERITY_LABELS[alert.severity] || alert.severity,
    severitySource: alert.severitySource,
    title: alert.title,
    body: alert.body,
    status: alert.status,
    createdAt: alert.createdAt,
    details,
    customerName: reservation?.customerName ?? null,
    overallScore: fr?.overallScore ?? null,
    recoveryContactRequested: !!fr?.recoveryContactRequested,
    recoveryContactEmail: fr?.recoveryContactEmail ?? reservation?.customerEmail ?? null,
  };
}

module.exports = {
  ALERT_DETAIL_INCLUDE,
  buildRecoveryAlertContent,
  buildAlertDetailLines,
  formatAlertForApi,
  SEVERITY_LABELS,
};
