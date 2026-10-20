const HOST_MAX = 253;
const LABEL_MAX = 63;

/**
 * Hostname del sitio que incrusta el widget.
 * Minúsculas, sin www, solo [a-z0-9.-]. Inválido → null (la reserva igual se crea).
 */
function parseEmbedHost(raw) {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || host.length > HOST_MAX) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.');
  for (const label of labels) {
    if (!label || label.length > LABEL_MAX) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
  }
  return host;
}

module.exports = { parseEmbedHost };
