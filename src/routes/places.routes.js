const express = require('express');
const { authenticateToken } = require('../middleware/authentication');

const router = express.Router();

const PLACES_BASE = 'https://places.googleapis.com/v1/places';

/**
 * Builds a short address from Google Place addressComponents.
 * Result: "{route} {street_number}, {locality}"
 * e.g. "Gral. Blanche 9792, Las Condes"
 */
function buildShortAddress(components) {
  if (!Array.isArray(components) || components.length === 0) return null;
  const get = (type) =>
    components.find((c) => Array.isArray(c.types) && c.types.includes(type))?.longText ?? '';
  const route = get('route');
  const number = get('street_number');
  const locality = get('locality') || get('sublocality_level_1') || get('administrative_area_level_3');
  const street = [route, number].filter(Boolean).join(' ');
  const short = [street, locality].filter(Boolean).join(', ');
  return short || null;
}

/**
 * GET /api/places/autocomplete
 * Proxies Google Places Autocomplete (New API). Requires authentication.
 * Query params:
 *   input       - text typed by user (required)
 *   sessionToken - optional session token for billing
 *   country     - ISO 3166-1 alpha-2 code to restrict results (default: cl)
 */
router.get('/autocomplete', authenticateToken, async (req, res, next) => {
  try {
    const { input, sessionToken, country = 'cl' } = req.query;

    if (!input || typeof input !== 'string' || !input.trim()) {
      return res.status(400).json({ error: 'El parámetro "input" es requerido.' });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Google Places API no está configurada.' });
    }

    const body = {
      input: input.trim(),
      languageCode: 'es',
      regionCode: country.toLowerCase(),
      includedRegionCodes: [country.toLowerCase()],
    };
    if (sessionToken) body.sessionToken = sessionToken;

    const response = await fetch(`${PLACES_BASE}:autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.error?.message || 'Error al contactar Google Places.';
      return res.status(502).json({ error: errMsg });
    }

    const suggestions = data.suggestions ?? [];
    const predictions = suggestions
      .filter((s) => s.placePrediction)
      .map((s) => {
        const p = s.placePrediction;
        return {
          placeId: p.placeId,
          description: p.text?.text ?? '',
          mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
          secondaryText: p.structuredFormat?.secondaryText?.text ?? '',
        };
      });

    return res.json({ predictions });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/details
 * Proxies Google Place Details (New API). Requires authentication.
 * Query params:
 *   placeId      - Google place_id (required)
 *   sessionToken - optional session token for billing
 */
router.get('/details', authenticateToken, async (req, res, next) => {
  try {
    const { placeId, sessionToken } = req.query;

    if (!placeId || typeof placeId !== 'string' || !placeId.trim()) {
      return res.status(400).json({ error: 'El parámetro "placeId" es requerido.' });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Google Places API no está configurada.' });
    }

    const headers = {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents',
    };
    if (sessionToken) headers['X-Goog-Session-Token'] = sessionToken;

    const response = await fetch(`${PLACES_BASE}/${encodeURIComponent(placeId.trim())}`, {
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.error?.message || 'Error al contactar Google Places.';
      return res.status(502).json({ error: errMsg });
    }

    return res.json({
      placeId: data.id,
      formattedAddress: data.formattedAddress ?? null,
      shortAddress: buildShortAddress(data.addressComponents),
      latitude: data.location?.latitude ?? null,
      longitude: data.location?.longitude ?? null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
