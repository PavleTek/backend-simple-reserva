'use strict';

/**
 * Detección de cobros recurrentes fallidos que Mercado Pago NO refleja en el status
 * del preapproval. MP solo documenta pending|authorized|paused|cancelled para
 * preapproval.status — no existe "payment_required" en la API actual. Ante un cobro
 * rechazado, MP deja el preapproval en "authorized" y reintenta por su cuenta (hasta
 * 4 veces en ~10 días), y solo cancela tras 3 ciclos consecutivos fallidos. Por eso no
 * podemos esperar a que MP cambie el status del preapproval para reaccionar.
 */

/**
 * ¿Un pago individual rechazado debe tirar la suscripción activa a periodo de gracia?
 * Solo aplica a una renovación real (sub activa de débito automático con preapproval
 * vigente) y no cuando hay un checkout en curso (alta nueva, upgrade o reactivación),
 * para no castigar una suscripción sana por el primer intento fallido de OTRO preapproval.
 * @param {{ activeSub: { status?: string, billingStrategy?: string, mercadopagoPreapprovalId?: string|null } | null, hasPendingCheckout: boolean }} params
 */
function shouldEnterGraceFromRejectedPayment({ activeSub, hasPendingCheckout }) {
  return !!(
    !hasPendingCheckout &&
    activeSub?.status === 'active' &&
    activeSub?.billingStrategy === 'automatic_recurring' &&
    activeSub?.mercadopagoPreapprovalId
  );
}

/**
 * Ventana tras currentPeriodEnd en la que el reconciliador NO entra a gracia aún.
 * MP suele cobrar la renovación minutos/horas después del aniversario; sin este
 * buffer generamos falsas alertas (caso Nuevo Localcin: gracia a las 04:00 UTC,
 * cobro OK a las 04:18 UTC). Un rechazo real de pago sigue entrando a gracia de
 * inmediato por el webhook de payment rejected — este buffer solo aplica al cron.
 */
const OVERDUE_RECONCILIATION_BUFFER_MS = 6 * 60 * 60 * 1000;

/**
 * Ancla la detección de mora al currentPeriodEnd propio en vez de a un status de MP
 * que nunca llega. Si el último cobro exitoso de MP es POSTERIOR a nuestro
 * currentPeriodEnd registrado, MP sí cobró y solo estamos desincronizados (webhook
 * perdido) → sincroniza. Si no, el periodo venció sin un cobro nuevo → mora real,
 * pero solo después del buffer (ver OVERDUE_RECONCILIATION_BUFFER_MS).
 * @param {{ mpStatus: string|null, currentPeriodEnd: Date|null, lastChargedDate: Date|null, now?: Date }} params
 * @returns {{ action: 'enter_grace' | 'sync_period_end' | 'none' }}
 */
function decideOverdueAutomaticSubAction({ mpStatus, currentPeriodEnd, lastChargedDate, now = new Date() }) {
  if (mpStatus !== 'authorized' || !currentPeriodEnd || new Date(currentPeriodEnd) >= now) {
    return { action: 'none' };
  }
  const mpChargedSincePeriodEnd = !!(lastChargedDate && new Date(lastChargedDate) > new Date(currentPeriodEnd));
  if (mpChargedSincePeriodEnd) {
    return { action: 'sync_period_end' };
  }
  const overdueMs = now.getTime() - new Date(currentPeriodEnd).getTime();
  if (overdueMs < OVERDUE_RECONCILIATION_BUFFER_MS) {
    return { action: 'none' };
  }
  return { action: 'enter_grace' };
}

module.exports = {
  shouldEnterGraceFromRejectedPayment,
  decideOverdueAutomaticSubAction,
  OVERDUE_RECONCILIATION_BUFFER_MS,
};
