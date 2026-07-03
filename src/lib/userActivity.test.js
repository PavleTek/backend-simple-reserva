'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { USER_ACTIVITY_TOUCH_INTERVAL_MS, touchUserActivity } = require('./userActivity');

test('USER_ACTIVITY_TOUCH_INTERVAL_MS is 30 minutes', () => {
  assert.equal(USER_ACTIVITY_TOUCH_INTERVAL_MS, 30 * 60 * 1000);
});

test('touchUserActivity updates when lastLogin is null', async () => {
  const now = new Date('2026-07-03T12:00:00.000Z');
  let updatedData = null;
  const prisma = {
    user: {
      async updateMany({ data }) {
        updatedData = data;
        return { count: 1 };
      },
      async findUnique() {
        throw new Error('should not read when update succeeded');
      },
    },
  };

  const result = await touchUserActivity(prisma, 'user-1');
  assert.equal(result.updated, true);
  assert.ok(result.lastLogin instanceof Date);
  assert.ok(updatedData.lastLogin instanceof Date);
});

test('touchUserActivity skips write when within throttle window', async () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000);
  let updateCalls = 0;
  const prisma = {
    user: {
      async updateMany() {
        updateCalls += 1;
        return { count: 0 };
      },
      async findUnique() {
        return { lastLogin: recent };
      },
    },
  };

  const result = await touchUserActivity(prisma, 'user-2');
  assert.equal(updateCalls, 1);
  assert.equal(result.updated, false);
  assert.equal(result.lastLogin, recent);
});
