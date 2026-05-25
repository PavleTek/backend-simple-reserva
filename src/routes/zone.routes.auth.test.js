const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('GET /zones usa ROLES_CONFIG_VIEW (incluye anfitrión)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'zone.routes.js'), 'utf8');
  assert.match(
    src,
    /router\.get\(\s*['"]\/['"]\s*,\s*authenticateRestaurantRoles\(ROLES_CONFIG_VIEW\)/,
  );
  assert.doesNotMatch(src, /router\.use\(\s*authenticateRestaurantRoles\(ROLES_CONFIG\)\s*\)/);
});
