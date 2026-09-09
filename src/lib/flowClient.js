'use strict';

const crypto = require('crypto');
const { getFlowApiKey, getFlowSecretKey, getFlowBaseUrl } = require('./flowEnv');

const TRANSIENT_ERROR_PATTERN = /premature close|invalid response body|network|econnreset|socket hang up|etimedout|econnrefused|fetch failed/i;

class FlowApiError extends Error {
  constructor(message, { status, code, payload } = {}) {
    super(message);
    this.name = 'FlowApiError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.payload = payload ?? null;
  }
}

function isTransientNetworkError(err) {
  return TRANSIENT_ERROR_PATTERN.test(err?.message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFlowRetry(fn, { attempts = 5, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isTransientNetworkError(err) || (err?.status >= 500);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

function stringifyParam(value) {
  if (value === true) return '1';
  if (value === false) return '0';
  return String(value);
}

/**
 * Build the HMAC-SHA256 signature Flow expects:
 * sort param names alphabetically, concatenate name+value, sign with secretKey.
 * @param {Record<string, string|number|boolean>} params without `s`
 * @param {string} secretKey
 */
function signFlowParams(params, secretKey) {
  const keys = Object.keys(params).filter((k) => k !== 's' && params[k] !== undefined && params[k] !== null);
  keys.sort();
  let toSign = '';
  for (const key of keys) {
    toSign += key + stringifyParam(params[key]);
  }
  return crypto.createHmac('sha256', secretKey).update(toSign).digest('hex');
}

function buildSignedParams(extra = {}) {
  const apiKey = getFlowApiKey();
  const secretKey = getFlowSecretKey();
  if (!apiKey || !secretKey) {
    throw new FlowApiError('FLOW_API_KEY / FLOW_SECRET_KEY no configurados', { status: 503 });
  }
  const params = { apiKey };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    params[key] = value;
  }
  params.s = signFlowParams(params, secretKey);
  return params;
}

function toSearchParams(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    qs.append(key, stringifyParam(value));
  }
  return qs;
}

async function parseFlowResponse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const message = data?.message || data?.msg || `Flow API error ${res.status}`;
    throw new FlowApiError(message, { status: res.status, code: data?.code, payload: data });
  }
  return data;
}

/**
 * @param {'GET'|'POST'} method
 * @param {string} path e.g. '/customer/create'
 * @param {Record<string, string|number|boolean>} [params]
 */
async function flowRequest(method, path, params = {}) {
  const signed = buildSignedParams(params);
  const url = `${getFlowBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

  return withFlowRetry(async () => {
    if (method === 'GET') {
      const res = await fetch(`${url}?${toSearchParams(signed).toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return parseFlowResponse(res);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toSearchParams(signed).toString(),
    });
    return parseFlowResponse(res);
  });
}

function flowGet(path, params) {
  return flowRequest('GET', path, params);
}

function flowPost(path, params) {
  return flowRequest('POST', path, params);
}

module.exports = {
  FlowApiError,
  signFlowParams,
  withFlowRetry,
  flowGet,
  flowPost,
  flowRequest,
};
