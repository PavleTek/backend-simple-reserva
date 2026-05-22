'use strict';

const prisma = require('../../lib/prisma');
const { analyzeCommentSeverity, maxSeverity } = require('./commentSeverity');
const { sendFeedbackRecoveryAlertEmail } = require('../notificationService');

/**
 * @param {number} overallScore
 * @param {number} recoveryThreshold
 * @param {object} categoryScores
 * @returns {{ triggered: boolean; scoreSeverity: 'none'|'low'|'medium'|'high' }}
 */
function evaluateScoreRecovery(overallScore, recoveryThreshold, categoryScores = {}) {
  const threshold = recoveryThreshold ?? 2;
  if (overallScore <= threshold) {
    const level = overallScore === 1 ? 'high' : overallScore === 2 ? 'medium' : 'low';
    return { triggered: true, scoreSeverity: level };
  }

  const cats = [
    categoryScores.serviceScore,
    categoryScores.foodScore,
    categoryScores.atmosphereScore,
    categoryScores.reservationScore,
  ].filter((s) => typeof s === 'number');

  if (cats.some((s) => s <= 2)) {
    return { triggered: true, scoreSeverity: 'medium' };
  }

  return { triggered: false, scoreSeverity: 'none' };
}

/**
 * @param {object} params
 * @returns {Promise<{ recoveryTriggered: boolean; alertId?: string }>}
 */
async function processRecovery({
  restaurantId,
  feedbackResponseId,
  overallScore,
  recoveryThreshold,
  categoryScores,
  comment,
  customerName,
  survey,
  restaurant,
}) {
  const scoreEval = evaluateScoreRecovery(overallScore, recoveryThreshold, categoryScores);
  const commentEval = analyzeCommentSeverity(comment);

  const finalSeverity = maxSeverity(
    scoreEval.scoreSeverity,
    commentEval.level === 'none' ? 'none' : commentEval.level
  );

  const triggered =
    scoreEval.triggered ||
    commentEval.level === 'high' ||
    (commentEval.level === 'medium' && overallScore <= 3);

  if (!triggered) {
    return { recoveryTriggered: false };
  }

  let severitySource = 'score';
  if (scoreEval.triggered && commentEval.level !== 'none') severitySource = 'both';
  else if (commentEval.level !== 'none') severitySource = 'comment';

  const severity = finalSeverity === 'none' ? 'medium' : finalSeverity;
  const title =
    severity === 'high'
      ? `Alerta recovery: ${customerName || 'Cliente'}`
      : `Experiencia a mejorar: ${customerName || 'Cliente'}`;

  const bodyParts = [
    `Puntuación general: ${overallScore}/5`,
    comment ? `Comentario: ${comment}` : null,
  ].filter(Boolean);

  const alert = await prisma.feedbackAlert.create({
    data: {
      restaurantId,
      feedbackResponseId,
      type: 'recovery',
      severity,
      severitySource,
      matchedKeywords: commentEval.matchedKeywords,
      title,
      body: bodyParts.join('\n'),
      status: 'open',
    },
  });

  if (survey?.notifyOnRecovery !== false) {
    const notifyEmail = survey?.notifyEmail || restaurant?.email;
    if (notifyEmail) {
      const panelBase = (process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175').replace(/\/$/, '');
      await sendFeedbackRecoveryAlertEmail({
        emails: [notifyEmail],
        restaurantName: restaurant?.name || 'Restaurante',
        customerName: customerName || 'Cliente',
        overallScore,
        comment: comment || '',
        severity,
        panelUrl: `${panelBase}/experiencia`,
      });
    }
  }

  return { recoveryTriggered: true, alertId: alert.id };
}

module.exports = { evaluateScoreRecovery, processRecovery };
