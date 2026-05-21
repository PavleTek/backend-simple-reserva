'use strict';

/**
 * v1: reglas simples por score + comentario
 * @param {number} overallScore
 * @param {string|null} comment
 * @returns {'positive'|'neutral'|'negative'}
 */
function inferSentiment(overallScore, comment) {
  if (overallScore >= 4) return 'positive';
  if (overallScore <= 2) return 'negative';
  if (comment && comment.length > 10) {
    const lower = comment.toLowerCase();
    if (/mal|malo|horrible|pésim|pesim|terrible|decepcion/.test(lower)) return 'negative';
    if (/excelente|genial|buen|encant|recomend/.test(lower)) return 'positive';
  }
  return 'neutral';
}

module.exports = { inferSentiment };
