/**
 * Asignación automática de mesa: mejor encaje para el grupo, luego orden del local (zona/mesa).
 *
 * - Prioriza mesas con menos “sobre-capacidad” (maxCapacity − partySize) para no desperdiciar mesas grandes.
 * - Respeta zone.sortOrder y table.sortOrder (mismo criterio que el panel al ordenar mesas).
 * - Si hay preferredZoneId (reserva web), primero mesas de esa zona, con la misma lógica dentro de cada grupo.
 */

/**
 * @param {{ id: string; maxCapacity: number; sortOrder?: number; zone: { id: string; sortOrder?: number } }} a
 * @param {{ id: string; maxCapacity: number; sortOrder?: number; zone: { id: string; sortOrder?: number } }} b
 * @param {number} partySize
 * @param {string | null | undefined} preferredZoneId
 * @returns {number}
 */
function compareTablesForAutoAssign(a, b, partySize, preferredZoneId) {
  if (preferredZoneId) {
    const ma = a.zone.id === preferredZoneId ? 0 : 1;
    const mb = b.zone.id === preferredZoneId ? 0 : 1;
    if (ma !== mb) return ma - mb;
  }

  const slackA = a.maxCapacity - partySize;
  const slackB = b.maxCapacity - partySize;
  if (slackA !== slackB) return slackA - slackB;

  const za = a.zone.sortOrder ?? 0;
  const zb = b.zone.sortOrder ?? 0;
  if (za !== zb) return za - zb;

  const sa = a.sortOrder ?? 0;
  const sb = b.sortOrder ?? 0;
  if (sa !== sb) return sa - sb;

  if (a.maxCapacity !== b.maxCapacity) return a.maxCapacity - b.maxCapacity;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * @param {string} tableId
 * @param {Array<{ tableId: string | null; dateTime: Date; durationMinutes: number }>} dayReservations
 * @param {Date} dateTime
 * @param {Date} slotEnd
 * @param {number} bufferMs
 */
function hasConflictOnTable(tableId, dayReservations, dateTime, slotEnd, bufferMs) {
  return dayReservations.some((r) => {
    if (r.tableId !== tableId) return false;
    const rEnd = new Date(r.dateTime.getTime() + r.durationMinutes * 60000 + bufferMs);
    return dateTime < rEnd && slotEnd > r.dateTime;
  });
}

/**
 * @param {Array<{ id: string; maxCapacity: number; sortOrder?: number; zone: { id: string; sortOrder?: number } }>} tables
 * @param {number} partySize
 * @param {Array<{ tableId: string | null; dateTime: Date; durationMinutes: number }>} dayReservations
 * @param {Date} dateTime
 * @param {Date} slotEnd
 * @param {number} bufferMs
 * @param {string | null | undefined} preferredZoneId
 * @returns {typeof tables[0] | null}
 */
function pickAutoTable(tables, partySize, dayReservations, dateTime, slotEnd, bufferMs, preferredZoneId) {
  const free = tables.filter(
    (t) => !hasConflictOnTable(t.id, dayReservations, dateTime, slotEnd, bufferMs)
  );
  if (free.length === 0) return null;
  free.sort((a, b) => compareTablesForAutoAssign(a, b, partySize, preferredZoneId));
  return free[0];
}

/**
 * Lista de mesas libres en el mismo orden que usaría la asignación automática (p. ej. dropdown del panel).
 *
 * @param {Array<{ id: string; maxCapacity: number; sortOrder?: number; zone: { id: string; sortOrder?: number } }>} freeTables
 * @param {number} partySize
 * @param {string | null | undefined} preferredZoneId
 */
function sortFreeTablesForUi(freeTables, partySize, preferredZoneId) {
  return [...freeTables].sort((a, b) => compareTablesForAutoAssign(a, b, partySize, preferredZoneId));
}

module.exports = {
  compareTablesForAutoAssign,
  hasConflictOnTable,
  pickAutoTable,
  sortFreeTablesForUi,
};
