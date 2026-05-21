'use strict';

/** Reglas v1 — es-CL, extensible */
const HIGH_KEYWORDS = [
  'cucaracha', 'cucarachas', 'rata', 'ratas', 'ratón', 'raton', 'plaga', 'plagas',
  'moho', 'hongo', 'hongos', 'sucio', 'suciedad', 'higiene', 'intoxic', 'enferm',
  'vómito', 'vomito', 'diarrea', 'salmonella', 'bacteria', 'veneno', 'emergencia',
  'acoso', 'acosaron', 'discrimin', 'racist', 'amenaza', 'amenazaron',
];

const MEDIUM_KEYWORDS = [
  'espera', 'demora', 'tard', 'lento', 'pedido equivocado', 'cobro', 'factura',
  'ruido', 'ruidoso', 'frío', 'frio', 'caliente mal', 'crudo', 'quemado',
  'mal servicio', 'groser', 'descortés', 'descortes',
];

/**
 * @param {string|null|undefined} comment
 * @returns {{ level: 'none'|'low'|'medium'|'high'; matchedKeywords: string[] }}
 */
function analyzeCommentSeverity(comment) {
  if (!comment || typeof comment !== 'string') {
    return { level: 'none', matchedKeywords: [] };
  }
  const text = comment.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const matched = [];

  for (const kw of HIGH_KEYWORDS) {
    if (text.includes(kw)) matched.push(kw);
  }
  if (matched.length > 0) {
    return { level: 'high', matchedKeywords: [...new Set(matched)] };
  }

  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) matched.push(kw);
  }
  if (matched.length > 0) {
    return { level: 'medium', matchedKeywords: [...new Set(matched)] };
  }

  return { level: 'none', matchedKeywords: [] };
}

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * @param {'none'|'low'|'medium'|'high'} a
 * @param {'none'|'low'|'medium'|'high'} b
 * @returns {'none'|'low'|'medium'|'high'}
 */
function maxSeverity(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

module.exports = { analyzeCommentSeverity, maxSeverity, HIGH_KEYWORDS, MEDIUM_KEYWORDS };
