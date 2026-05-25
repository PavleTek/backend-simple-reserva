const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('GET /subscription no usa middleware global que bloquee anfitrión en otras rutas', () => {
  const src = fs.readFileSync(path.join(__dirname, 'billing.routes.js'), 'utf8');
  assert.doesNotMatch(
    src,
    /router\.use\(\s*authenticateRestaurantRoles\(\[['"]restaurant_owner['"],\s*['"]restaurant_manager['"]\]\)\s*\)/,
    'El router no debe exigir owner/manager en todas las rutas (conflicto con /access-status en restaurant.routes)',
  );
  assert.match(
    src,
    /router\.get\(\s*['"]\/subscription['"]\s*,\s*authenticateRestaurantRoles\(ROLES_BILLING\)/,
  );
});
