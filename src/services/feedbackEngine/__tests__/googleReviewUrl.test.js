'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGoogleReviewUrl,
  shouldInviteGoogleReview,
  POSITIVE_REVIEW_MIN_SCORE,
} = require('../googleReviewUrl');

describe('resolveGoogleReviewUrl', () => {
  it('prefiere URL configurada en la encuesta', () => {
    const url = resolveGoogleReviewUrl(
      { googleReviewUrl: 'https://g.page/mi-local/review' },
      { googlePlaceId: 'ChIJxxx' },
    );
    assert.equal(url, 'https://g.page/mi-local/review');
  });

  it('genera writereview desde googlePlaceId del local', () => {
    const url = resolveGoogleReviewUrl(
      { googleReviewUrl: null },
      { googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' },
    );
    assert.equal(
      url,
      'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
  });

  it('devuelve null sin URL ni place id', () => {
    assert.equal(resolveGoogleReviewUrl({}, {}), null);
  });
});

describe('shouldInviteGoogleReview', () => {
  it(`invita desde ${POSITIVE_REVIEW_MIN_SCORE}/5`, () => {
    assert.equal(shouldInviteGoogleReview(3), false);
    assert.equal(shouldInviteGoogleReview(4), true);
    assert.equal(shouldInviteGoogleReview(5), true);
  });
});
