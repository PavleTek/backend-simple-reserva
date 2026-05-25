const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('GET /access-status expone límites operacionales sin facturación', () => {
  const src = fs.readFileSync(path.join(__dirname, 'restaurant.routes.js'), 'utf8');
  assert.match(src, /router\.get\(\s*['"]\/access-status['"]/);
  assert.match(src, /maxZonesPerRestaurant/);
  assert.match(src, /maxTables/);
  assert.match(src, /resolvePlanConfigForRestaurant/);
});
