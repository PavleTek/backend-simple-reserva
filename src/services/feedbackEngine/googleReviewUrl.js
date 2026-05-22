'use strict';

/** Puntuación mínima (1–5) para invitar a reseña pública en Google. */
const POSITIVE_REVIEW_MIN_SCORE = 4;

/**
 * @param {object|null|undefined} survey
 * @param {{ googlePlaceId?: string|null }} restaurant
 * @returns {string|null}
 */
function resolveGoogleReviewUrl(survey, restaurant) {
  const configured = survey?.googleReviewUrl?.trim();
  if (configured) return configured;

  const placeId = restaurant?.googlePlaceId?.trim();
  if (placeId) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  }

  return null;
}

/**
 * @param {number} overallScore
 * @returns {boolean}
 */
function shouldInviteGoogleReview(overallScore) {
  return Number.isInteger(overallScore) && overallScore >= POSITIVE_REVIEW_MIN_SCORE;
}

module.exports = {
  POSITIVE_REVIEW_MIN_SCORE,
  resolveGoogleReviewUrl,
  shouldInviteGoogleReview,
};
