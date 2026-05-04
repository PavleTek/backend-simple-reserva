/**
 * Tipo de cambio referencial CLP por 1 USD (Chile).
 * mindic.cl agrega el dólar observado; si falla, usa FALLBACK_CLP_PER_USD.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache = {
  clpPerUsd: null,
  asOf: null,
  expiresAt: 0,
};

function fallbackRate() {
  const n = parseFloat(process.env.FALLBACK_CLP_PER_USD || "950", 10);
  return Number.isFinite(n) && n > 0 ? n : 950;
}

async function fetchMindicUsd() {
  const res = await fetch("https://mindic.cl/api/usd", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`mindic HTTP ${res.status}`);
  }
  const data = await res.json();
  const serie = data.serie;
  if (!Array.isArray(serie) || serie.length === 0) {
    throw new Error("mindic: serie vacía");
  }
  const last = serie[serie.length - 1];
  const clpPerUsd = Number(last.valor);
  if (!Number.isFinite(clpPerUsd) || clpPerUsd <= 0) {
    throw new Error("mindic: valor inválido");
  }
  return {
    clpPerUsd,
    asOf: typeof last.fecha === "string" ? last.fecha : new Date().toISOString(),
  };
}

/**
 * @returns {{ clpPerUsd: number, asOf: string, source: 'cache'|'mindic'|'fallback' }}
 */
async function getClpPerUsd() {
  const now = Date.now();
  if (cache.clpPerUsd != null && cache.expiresAt > now) {
    return {
      clpPerUsd: cache.clpPerUsd,
      asOf: cache.asOf || new Date().toISOString(),
      source: "cache",
    };
  }

  try {
    const { clpPerUsd, asOf } = await fetchMindicUsd();
    cache = {
      clpPerUsd,
      asOf,
      expiresAt: now + CACHE_TTL_MS,
    };
    return { clpPerUsd, asOf, source: "mindic" };
  } catch {
    const clpPerUsd = fallbackRate();
    const asOf = new Date().toISOString();
    cache = {
      clpPerUsd,
      asOf,
      expiresAt: now + 15 * 60 * 1000,
    };
    return { clpPerUsd, asOf, source: "fallback" };
  }
}

module.exports = { getClpPerUsd };
