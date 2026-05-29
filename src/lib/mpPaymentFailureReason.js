'use strict';

/** @type {Record<string, { ownerMessage: string; adminHint: string }>} */
const KNOWN_DETAILS = {
  cc_rejected_insufficient_amount: {
    ownerMessage: 'La tarjeta no tiene fondos suficientes para completar el pago.',
    adminHint: 'Sugerir otra tarjeta o medio de pago; verificar límite diario en el banco.',
  },
  cc_rejected_bad_filled_security_code: {
    ownerMessage: 'El código de seguridad (CVV) ingresado no es válido.',
    adminHint: 'Pedir que reintente con el CVV correcto.',
  },
  cc_rejected_bad_filled_date: {
    ownerMessage: 'La fecha de vencimiento de la tarjeta no es válida.',
    adminHint: 'Verificar mes/año de vencimiento en el formulario de MP.',
  },
  cc_rejected_bad_filled_other: {
    ownerMessage: 'Algún dato de la tarjeta no es válido. Revisa número, fecha y CVV.',
    adminHint: 'Error de datos del titular; revisar formulario MP.',
  },
  cc_rejected_call_for_authorize: {
    ownerMessage: 'Tu banco requiere autorización para este pago. Llama a tu banco e intenta de nuevo.',
    adminHint: 'El cliente debe autorizar con el banco emisor.',
  },
  cc_rejected_card_disabled: {
    ownerMessage: 'La tarjeta está deshabilitada. Contacta a tu banco o usa otra tarjeta.',
    adminHint: 'Tarjeta bloqueada o inactiva en el emisor.',
  },
  cc_rejected_duplicated_payment: {
    ownerMessage: 'Detectamos un pago duplicado reciente. Si ya pagaste, ignora este aviso.',
    adminHint: 'Posible doble intento; verificar si el cobro ya quedó aprobado.',
  },
  cc_rejected_high_risk: {
    ownerMessage: 'El pago fue rechazado por seguridad. Prueba con otra tarjeta o contacta a soporte.',
    adminHint: 'Rechazo antifraude MP; intentar otro medio o contactar MP.',
  },
  cc_rejected_max_attempts: {
    ownerMessage: 'Superaste el máximo de intentos con esta tarjeta. Espera un momento o usa otra.',
    adminHint: 'Límite de reintentos MP alcanzado.',
  },
  cc_rejected_other_reason: {
    ownerMessage: 'Tu banco rechazó el pago. Contacta a tu banco o prueba con otra tarjeta.',
    adminHint: 'Rechazo genérico del emisor.',
  },
  rejected_by_bank: {
    ownerMessage: 'Tu banco rechazó el pago.',
    adminHint: 'Rechazo del banco emisor.',
  },
  rejected_by_regulations: {
    ownerMessage: 'El pago no pudo procesarse por regulaciones del medio de pago.',
    adminHint: 'Revisar restricciones MP / tipo de tarjeta.',
  },
  expired: {
    ownerMessage: 'El intento de pago expiró. Genera un nuevo link desde Facturación.',
    adminHint: 'Preferencia o sesión expirada.',
  },
};

/**
 * @param {Object} [mpPayment]
 * @param {string} [mpPayment.status]
 * @param {string} [mpPayment.status_detail]
 * @param {string|number} [mpPayment.id]
 * @returns {{ ownerMessage: string; adminHint: string; statusDetail: string|null; paymentId: string|null }}
 */
function classifyMpPaymentFailure(mpPayment) {
  const statusDetail = mpPayment?.status_detail ? String(mpPayment.status_detail) : null;
  const paymentId = mpPayment?.id != null ? String(mpPayment.id) : null;
  const known = statusDetail ? KNOWN_DETAILS[statusDetail] : null;

  if (known) {
    return {
      ownerMessage: known.ownerMessage,
      adminHint: known.adminHint,
      statusDetail,
      paymentId,
    };
  }

  const status = mpPayment?.status ? String(mpPayment.status) : 'rejected';
  return {
    ownerMessage: 'No pudimos procesar el pago. Puedes intentar de nuevo desde Facturación.',
    adminHint: statusDetail
      ? `MP status=${status}, detail=${statusDetail}${paymentId ? `, paymentId=${paymentId}` : ''}`
      : `MP status=${status}${paymentId ? `, paymentId=${paymentId}` : ''}`,
    statusDetail,
    paymentId,
  };
}

module.exports = {
  classifyMpPaymentFailure,
  KNOWN_DETAILS,
};
