'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const prismaPath = require.resolve('../lib/prisma');
const notificationPath = require.resolve('../services/notificationService');

describe('resolveReservationNotifyEmails', () => {
  let originalPrisma;
  let resolveReservationNotifyEmails;

  before(() => {
    originalPrisma = require('../lib/prisma');
    const mockPrisma = {
      restaurantOrganization: {
        findUnique: async ({ where }) => {
          if (where.id === 'org-owner') {
            return { owner: { email: 'Owner@Example.com' } };
          }
          if (where.id === 'org-all') {
            return { owner: { email: 'owner@test.com' } };
          }
          if (where.id === 'org-empty') {
            return { owner: null };
          }
          return null;
        },
      },
      organizationManager: {
        findMany: async ({ where }) => {
          if (where.organizationId === 'org-managers') {
            return [
              { user: { email: 'manager1@test.com' } },
              { user: { email: 'MANAGER1@test.com' } },
            ];
          }
          if (where.organizationId === 'org-all') {
            return [{ user: { email: 'manager@test.com' } }];
          }
          return [];
        },
      },
      organizationHost: {
        findMany: async ({ where }) => {
          if (where.organizationId === 'org-hosts') {
            return [{ user: { email: 'host@test.com' } }];
          }
          if (where.organizationId === 'org-all') {
            return [{ user: { email: 'host@test.com' } }];
          }
          return [];
        },
      },
    };
    require.cache[prismaPath].exports = mockPrisma;
    delete require.cache[notificationPath];
    ({ resolveReservationNotifyEmails } = require('../services/notificationService'));
  });

  after(() => {
    require.cache[prismaPath].exports = originalPrisma;
    delete require.cache[notificationPath];
  });

  it('returns normalized owner email', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'org-owner',
      restaurantId: 'rest-1',
      audience: 'owner',
    });
    assert.deepEqual(emails, ['owner@example.com']);
  });

  it('returns custom email only for custom audience', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'org-owner',
      restaurantId: 'rest-1',
      audience: 'custom',
      customEmail: ' Reservas@Restaurante.cl ',
    });
    assert.deepEqual(emails, ['reservas@restaurante.cl']);
  });

  it('deduplicates manager emails', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'org-managers',
      restaurantId: 'rest-1',
      audience: 'managers',
    });
    assert.deepEqual(emails, ['manager1@test.com']);
  });

  it('combines owner, managers and hosts for all audience', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'org-all',
      restaurantId: 'rest-1',
      audience: 'all',
    });
    assert.deepEqual(emails.sort(), ['host@test.com', 'manager@test.com', 'owner@test.com'].sort());
  });

  it('returns empty array when organization is missing', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'missing',
      restaurantId: 'rest-1',
      audience: 'owner',
    });
    assert.deepEqual(emails, []);
  });

  it('returns empty array for owner audience without owner email', async () => {
    const emails = await resolveReservationNotifyEmails({
      organizationId: 'org-empty',
      restaurantId: 'rest-1',
      audience: 'owner',
    });
    assert.deepEqual(emails, []);
  });
});
