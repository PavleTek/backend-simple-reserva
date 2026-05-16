/**
 * Tipo de cambio referencial CLP por 1 USD (Chile).
 * Orden: dólar observado (mindic.cl, agrega la serie del BCCh) → Frankfurter v2 (BCE)
 * → API pública en CDN → FALLBACK_CLP_PER_USD.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 15 * 60 * 1000;

let cache = {
  clpPerUsd: null,
  asOf: null,
  expiresAt: 0,
  source: null,
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
    source: "mindic",
  };
}

async function fetchFrankfurterUsdClp() {
  const res = await fetch("https://api.frankfurter.dev/v2/rate/USD/CLP", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`frankfurter HTTP ${res.status}`);
  }
  const data = await res.json();
  const clpPerUsd = data.rate;
  if (!Number.isFinite(clpPerUsd) || !clpPerUsd || clpPerUsd <= 0) {
    throw new Error("frankfurter: tasa CLP ausente");
  }
  return {
    clpPerUsd,
    asOf: data.date ? `${data.date}T12:00:00.000Z` : new Date().toISOString(),
    source: "frankfurter",
  };
}

async function fetchCurrencyApiJsDelivr() {
  const res = await fetch(
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`currency-api HTTP ${res.status}`);
  }
  const data = await res.json();
  const nested = data.usd?.clp;
  const flat = data.clp;
  const clpPerUsd = typeof nested === "number" ? nested : typeof flat === "number" ? flat : NaN;
  if (!Number.isFinite(clpPerUsd) || clpPerUsd <= 0) {
    throw new Error("currency-api: CLP ausente");
  }
  return {
    clpPerUsd,
    asOf: data.date ? `${data.date}T12:00:00.000Z` : new Date().toISOString(),
    source: "currency-api-jsdelivr",
  };
}

async function fetchFromProviders() {
  const attempts = [fetchMindicUsd, fetchFrankfurterUsdClp, fetchCurrencyApiJsDelivr];
  let lastErr;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("sin proveedor de tipo de cambio");
}

/**
 * @returns {{ clpPerUsd: number, asOf: string, source: 'mindic'|'frankfurter'|'currency-api-jsdelivr'|'fallback' }}
 */
async function getClpPerUsd() {
  const now = Date.now();
  if (cache.clpPerUsd != null && cache.expiresAt > now && cache.source) {
    return {
      clpPerUsd: cache.clpPerUsd,
      asOf: cache.asOf || new Date().toISOString(),
      source: cache.source,
    };
  }

  try {
    const row = await fetchFromProviders();
    cache = {
      clpPerUsd: row.clpPerUsd,
      asOf: row.asOf,
      expiresAt: now + CACHE_TTL_MS,
      source: row.source,
    };
    return { clpPerUsd: row.clpPerUsd, asOf: row.asOf, source: row.source };
  } catch {
    const clpPerUsd = fallbackRate();
    const asOf = new Date().toISOString();
    cache = {
      clpPerUsd,
      asOf,
      expiresAt: now + FALLBACK_CACHE_TTL_MS,
      source: "fallback",
    };
    return { clpPerUsd, asOf, source: "fallback" };
  }
}

module.exports = { getClpPerUsd };
