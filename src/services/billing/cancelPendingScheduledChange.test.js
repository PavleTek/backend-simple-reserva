'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lógica de detección (espejo de cancelPendingScheduledChange) para documentar casos.
 */
function hasDbScheduledPlanChange(activeSub) {
  return !!(activeSub?.scheduledPlanId && activeSub?.scheduledChangeAt);
}

test('hasDbScheduledPlanChange: true cuando hay scheduledPlanId y scheduledChangeAt', () => {
  assert.equal(
    hasDbScheduledPlanChange({
      scheduledPlanId: 'plan-id',
      scheduledChangeAt: new Date(),
    }),
    true,
  );
});

test('hasDbScheduledPlanChange: false sin campos programados', () => {
  assert.equal(hasDbScheduledPlanChange({ status: 'active' }), false);
  assert.equal(
    hasDbScheduledPlanChange({ scheduledPlanId: 'x', scheduledChangeAt: null }),
    false,
  );
});
