const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Regresión: el anfitrión debe poder leer horarios (panel, agenda) pero no editarlos.
 * Ver commit d668a1c — antes router.use(ROLES_CONFIG) bloqueaba el GET.
 */
test('GET /schedules usa ROLES_CONFIG_VIEW (incluye anfitrión)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'schedule.routes.js'), 'utf8');
  assert.match(
    src,
    /router\.get\(\s*['"]\/['"]\s*,\s*authenticateRestaurantRoles\(ROLES_CONFIG_VIEW\)/,
    'GET debe permitir lectura operacional (owner, manager, host)',
  );
  assert.doesNotMatch(
    src,
    /router\.use\(\s*authenticateRestaurantRoles\(ROLES_CONFIG\)\s*\)/,
    'No debe haber middleware ROLES_CONFIG a nivel de router (bloquea GET)',
  );
});

test('PUT /schedules sigue restringido a owner y manager', () => {
  const src = fs.readFileSync(path.join(__dirname, 'schedule.routes.js'), 'utf8');
  assert.match(
    src,
    /router\.put\(\s*['"]\/['"]\s*,\s*authenticateRestaurantRoles\(ROLES_CONFIG\)/,
    'PUT debe seguir en ROLES_CONFIG',
  );
});
