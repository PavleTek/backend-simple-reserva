'use strict';

/** Ventas estimadas = cubiertos completed × ticket. Nunca se etiqueta "Revenue" en UI. */
function estimatedRevenue(covers, ticketCLP) {
  if (covers == null || ticketCLP == null) return null;
  const c = Number(covers);
  const t = Number(ticketCLP);
  if (!Number.isFinite(c) || !Number.isFinite(t) || c < 0 || t <= 0) return null;
  return c * t;
}

module.exports = { estimatedRevenue };
