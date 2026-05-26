/**
 * Rango inclusivo en UTC para consultas por día (YYYY-MM-DD o ISO).
 */
function parseUtcDateRange(dateFrom, dateTo, defaultDays = 30) {
  const now = new Date();

  if (dateFrom && dateTo) {
    const fromStr = String(dateFrom).slice(0, 10);
    const toStr = String(dateTo).slice(0, 10);
    const fromParts = fromStr.split('-').map(Number);
    const toParts = toStr.split('-').map(Number);
    if (fromParts.length !== 3 || toParts.length !== 3 || fromParts.some(Number.isNaN) || toParts.some(Number.isNaN)) {
      return { error: 'Formato de fecha inválido (usa YYYY-MM-DD)' };
    }
    const from = new Date(Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2], 0, 0, 0, 0));
    const to = new Date(Date.UTC(toParts[0], toParts[1] - 1, toParts[2], 23, 59, 59, 999));
    if (from > to) return { error: 'Rango de fechas inválido' };
    return { from, to };
  }

  const to = now;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - defaultDays);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to };
}

module.exports = { parseUtcDateRange };
