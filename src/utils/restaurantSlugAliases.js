'use strict';

/** Legacy public slugs → current slug (e.g. after rename in panel). */
const SLUG_ALIASES = {
  'quercus-bar': 'quercus',
};

function resolvePublicRestaurantSlug(slug) {
  if (!slug || typeof slug !== 'string') return slug;
  return SLUG_ALIASES[slug] || slug;
}

module.exports = { SLUG_ALIASES, resolvePublicRestaurantSlug };
