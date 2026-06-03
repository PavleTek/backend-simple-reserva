'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decidePreapprovalTerminalAction } = require('./handlePreapprovalTerminalStatus');

test('decidePreapprovalTerminalAction: reemplazo con otra sub activa', () => {
  assert.equal(
    decidePreapprovalTerminalAction({
      hasOtherActiveEntitlement: true,
      linkedStatus: 'active',
      stillInPeriod: true,
    }),
    'ignore_replacement',
  );
});

test('decidePreapprovalTerminalAction: scheduled cancelado en MP', () => {
  assert.equal(
    decidePreapprovalTerminalAction({
      hasOtherActiveEntitlement: false,
      linkedStatus: 'scheduled',
      stillInPeriod: false,
    }),
    'cancel_scheduled',
  );
});

test('decidePreapprovalTerminalAction: activo en periodo → cancel at end', () => {
  assert.equal(
    decidePreapprovalTerminalAction({
      hasOtherActiveEntitlement: false,
      linkedStatus: 'active',
      stillInPeriod: true,
    }),
    'cancel_at_period_end',
  );
});

test('decidePreapprovalTerminalAction: activo fuera de periodo → expire', () => {
  assert.equal(
    decidePreapprovalTerminalAction({
      hasOtherActiveEntitlement: false,
      linkedStatus: 'active',
      stillInPeriod: false,
    }),
    'expire',
  );
});

test('decidePreapprovalTerminalAction: grace → expire', () => {
  assert.equal(
    decidePreapprovalTerminalAction({
      hasOtherActiveEntitlement: false,
      linkedStatus: 'grace',
      stillInPeriod: true,
    }),
    'expire',
  );
});

test('webhook no llama enterGracePeriod ante cancelled/expired de MP', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../routes/webhooks.routes.js'), 'utf8');
  const branch = src.slice(src.indexOf("status === 'cancelled'"));
  assert.doesNotMatch(branch.slice(0, 400), /enterGracePeriod/);
  assert.match(branch.slice(0, 400), /applyBillingEvent/);
});
