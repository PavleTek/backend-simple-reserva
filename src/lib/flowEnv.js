'use strict';

/**
 * Resolve Flow.cl credentials by deployment environment.
 *
 * Default:
 * - NODE_ENV === 'production' → *_PRODUCTION
 * - otherwise → *_DEVELOPMENT
 *
 * Override: FLOW_ENV=development | production
 */

function trimmed(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function flowUseProductionCredentials() {
  const flag = trimmed('FLOW_ENV').toLowerCase();
  if (flag === 'production') return true;
  if (flag === 'development') return false;
  return process.env.NODE_ENV === 'production';
}

function pickCred(devKey, prodKey, fallbackKey) {
  const prod = flowUseProductionCredentials();
  const legacy = fallbackKey ? trimmed(fallbackKey) : '';
  const devOnly = trimmed(devKey);
  const prodOnly = trimmed(prodKey);
  if (prod) return prodOnly || legacy;
  return devOnly || legacy;
}

function getFlowApiKey() {
  return pickCred('FLOW_API_KEY_DEVELOPMENT', 'FLOW_API_KEY_PRODUCTION', 'FLOW_API_KEY');
}

function getFlowSecretKey() {
  return pickCred('FLOW_SECRET_KEY_DEVELOPMENT', 'FLOW_SECRET_KEY_PRODUCTION', 'FLOW_SECRET_KEY');
}

function getFlowBaseUrl() {
  const override = trimmed('FLOW_BASE_URL');
  if (override) return override.replace(/\/$/, '');
  return flowUseProductionCredentials()
    ? 'https://www.flow.cl/api'
    : 'https://sandbox.flow.cl/api';
}

function describeFlowCredentialChoice() {
  const prod = flowUseProductionCredentials();
  const override = trimmed('FLOW_ENV');
  let source = prod ? 'production' : 'development';
  if (override) source += ` (FLOW_ENV=${override})`;
  else if (process.env.NODE_ENV === 'production' && prod) source += ' (NODE_ENV=production)';

  const apiKey = getFlowApiKey();
  let whichKey = '(ninguno)';
  if (apiKey) {
    if (prod && trimmed('FLOW_API_KEY_PRODUCTION')) whichKey = 'FLOW_API_KEY_PRODUCTION';
    else if (!prod && trimmed('FLOW_API_KEY_DEVELOPMENT')) whichKey = 'FLOW_API_KEY_DEVELOPMENT';
    else if (trimmed('FLOW_API_KEY')) whichKey = 'FLOW_API_KEY';
    else whichKey = '(resuelto)';
  }

  return { prod, source, apiKeyEnvKey: whichKey, baseUrl: getFlowBaseUrl() };
}

module.exports = {
  flowUseProductionCredentials,
  getFlowApiKey,
  getFlowSecretKey,
  getFlowBaseUrl,
  describeFlowCredentialChoice,
};
