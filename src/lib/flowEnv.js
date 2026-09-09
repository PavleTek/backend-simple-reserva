'use strict';

function trimmed(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function getFlowApiKey() {
  return trimmed('FLOW_API_KEY_PRODUCTION') || trimmed('FLOW_API_KEY');
}

function getFlowSecretKey() {
  return trimmed('FLOW_SECRET_KEY_PRODUCTION') || trimmed('FLOW_SECRET_KEY');
}

function getFlowBaseUrl() {
  const override = trimmed('FLOW_BASE_URL');
  if (override) return override.replace(/\/$/, '');
  return 'https://www.flow.cl/api';
}

function describeFlowCredentialChoice() {
  const apiKey = getFlowApiKey();
  let whichKey = '(ninguno)';
  if (apiKey) {
    whichKey = trimmed('FLOW_API_KEY_PRODUCTION') ? 'FLOW_API_KEY_PRODUCTION' : 'FLOW_API_KEY';
  }
  return {
    prod: true,
    source: 'production',
    apiKeyEnvKey: whichKey,
    baseUrl: getFlowBaseUrl(),
  };
}

module.exports = {
  getFlowApiKey,
  getFlowSecretKey,
  getFlowBaseUrl,
  describeFlowCredentialChoice,
};
