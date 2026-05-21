'use strict';

/**
 * Índice de satisfacción (escala 1–5, NO NPS 0–10).
 * Fórmula: % promotores (4–5) − % detractores (1–2).
 *
 * @param {number[]} scores - overallScore 1–5
 * @returns {{ index: number|null; promotersPct: number; detractorsPct: number; average: number|null; count: number }}
 */
function computeSatisfactionIndex(scores) {
  const valid = scores.filter((s) => typeof s === 'number' && s >= 1 && s <= 5);
  const count = valid.length;
  if (count === 0) {
    return { index: null, promotersPct: 0, detractorsPct: 0, average: null, count: 0 };
  }

  const promoters = valid.filter((s) => s >= 4).length;
  const detractors = valid.filter((s) => s <= 2).length;
  const promotersPct = (promoters / count) * 100;
  const detractorsPct = (detractors / count) * 100;
  const average = valid.reduce((a, b) => a + b, 0) / count;

  return {
    index: Math.round((promotersPct - detractorsPct) * 10) / 10,
    promotersPct: Math.round(promotersPct * 10) / 10,
    detractorsPct: Math.round(detractorsPct * 10) / 10,
    average: Math.round(average * 100) / 100,
    count,
  };
}

/**
 * @param {number} sent
 * @param {number} clicked
 * @param {number} completed
 * @returns {{ clickRate: number|null; responseRate: number|null; completionAfterClick: number|null }}
 */
function computeFunnelRates(sent, clicked, completed) {
  const clickRate = sent > 0 ? Math.round((clicked / sent) * 1000) / 10 : null;
  const responseRate = sent > 0 ? Math.round((completed / sent) * 1000) / 10 : null;
  const completionAfterClick = clicked > 0 ? Math.round((completed / clicked) * 1000) / 10 : null;
  return { clickRate, responseRate, completionAfterClick };
}

module.exports = { computeSatisfactionIndex, computeFunnelRates };
