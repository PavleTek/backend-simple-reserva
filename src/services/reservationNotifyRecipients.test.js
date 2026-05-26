'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const prismaPath = require.resolve('../lib/prisma');
const modulePath = require.resolve('./reservationNotifyRecipients');

describe('reservationNotifyRecipients', () => {
  let originalPrisma;
  let api;

  before(() => {
    originalPrisma = require('../lib/prisma');

    const mockPrisma = {
      restaurantOrganization: {
        findUnique: async ({ where }) => {
          if (where.id === 'org-1') {
            return {
              id: 'org-1',
              name: 'Cadena Test',
              owner: { id: 'owner-user', email: 'Owner@Test.com', name: 'Ana', lastName: 'López' },
            };
          }
          return null;
        },
      },
      organizationManager: {
        findMany: async ({ where }) => {
          if (where.organizationId === 'org-1') {
            return [
              {
                user: {
                  id: 'mgr-1',
                  email: 'gerente@test.com',
                  name: 'María',
                  lastName: null,
                },
              },
            ];
          }
          return [];
        },
      },
      organizationHost: {
        findMany: async ({ where }) => {
          if (where.organizationId === 'org-1') {
            return [
              {
                user: {
                  id: 'host-1',
                  email: 'HOST@test.com',
                  name: 'Pedro',
                  lastName: 'Soto',
                },
              },
            ];
          }
          return [];
        },
      },
      restaurant: {
        findUnique: async ({ where }) => {
          if (where.id === 'rest-1') {
            return {
              id: 'rest-1',
              name: 'Local Centro',
              organizationId: 'org-1',
              reservationNotifyRecipients: {
                owner: true,
                members: { 'mgr-1': true, 'host-1': false },
                extras: ['sala@restaurante.cl'],
              },
              reservationNotifyOnWeb: true,
              reservationNotifyOnManual: true,
            };
          }
          return null;
        },
        findFirst: async ({ where }) => {
          if (where.id === 'rest-1' && where.organizationId === 'org-1') {
            return {
              id: 'rest-1',
              name: 'Local Centro',
              organizationId: 'org-1',
              reservationNotifyRecipients: {
                owner: true,
                members: { 'mgr-1': true, 'host-1': false },
                extras: ['sala@restaurante.cl'],
              },
              reservationNotifyOnWeb: true,
              reservationNotifyOnManual: true,
            };
          }
          return null;
        },
        update: async ({ where, data }) => ({ id: where.id, ...data }),
      },
    };

    require.cache[prismaPath].exports = mockPrisma;
    delete require.cache[modulePath];
    api = require('./reservationNotifyRecipients');
  });

  after(() => {
    require.cache[prismaPath].exports = originalPrisma;
    delete require.cache[modulePath];
  });

  it('resolves emails from per-restaurant config and dedupes extras', async () => {
    const emails = await api.resolveReservationNotifyEmails('org-1', 'rest-1');
    assert.deepEqual(
      emails.sort(),
      ['gerente@test.com', 'owner@test.com', 'sala@restaurante.cl'].sort(),
    );
  });

  it('loads settings from the restaurant record only', async () => {
    const notify = await api.loadNotifySettings('org-1', 'rest-1');
    assert.equal(notify.onWeb, true);
    assert.equal(notify.onManual, true);
    assert.equal(notify.config.owner, true);
    assert.equal(notify.restaurant.name, 'Local Centro');
  });

  it('builds activeRecipients with role context', async () => {
    const payload = await api.buildNotificationSettingsResponse('org-1', 'rest-1');
    assert.equal(payload.restaurantName, 'Local Centro');
    assert.equal(payload.activeRecipients.length, 3);
    assert.ok(payload.activeRecipients.some((r) => r.kind === 'owner'));
  });

  it('dedupes extras that match team emails in configFromRecipientPatchList', async () => {
    const catalog = await api.loadRecipientCatalog('org-1', 'rest-1');
    const config = api.configFromRecipientPatchList(
      [
        { key: 'owner', enabled: true },
        { key: 'user:mgr-1', enabled: true },
        { key: 'extra:gerente@test.com', enabled: true, email: 'gerente@test.com' },
        { key: 'extra:sala@restaurante.cl', enabled: true, email: 'sala@restaurante.cl' },
      ],
      catalog,
    );
    assert.deepEqual(config.extras, ['sala@restaurante.cl']);
  });

  it('findRecipientByEmail matches normalized addresses', async () => {
    const rows = [
      { key: 'owner', email: 'Owner@Test.com', name: 'Ana', roleLabel: 'Propietario', enabled: false },
    ];
    const match = api.findRecipientByEmail(rows, ' owner@test.com ');
    assert.equal(match?.key, 'owner');
  });

  it('saveNotifySettings writes to the restaurant record', async () => {
    await assert.doesNotReject(() =>
      api.saveNotifySettings({
        organizationId: 'org-1',
        restaurantId: 'rest-1',
        recipients: [
          { key: 'owner', enabled: true },
          { key: 'extra:cocina@test.com', enabled: true, email: 'cocina@test.com' },
        ],
        reservationNotifyOnWeb: true,
        reservationNotifyOnManual: false,
      }),
    );
  });

  it('falls back to org legacy audience when restaurant has no JSON config', async () => {
    const prisma = require('../lib/prisma');
    const origRestaurantFind = prisma.restaurant.findUnique;
    const origOrgFind = prisma.restaurantOrganization.findUnique;

    prisma.restaurant.findUnique = async (args) => {
      if (args.where.id === 'rest-new') {
        return {
          id: 'rest-new',
          name: 'Local Nuevo',
          organizationId: 'org-1',
          reservationNotifyRecipients: null,
          reservationNotifyOnWeb: true,
          reservationNotifyOnManual: true,
        };
      }
      return origRestaurantFind(args);
    };

    prisma.restaurantOrganization.findUnique = async (args) => {
      if (args.where.id === 'org-1') {
        return {
          id: 'org-1',
          name: 'Cadena Test',
          reservationNotifyScope: 'restaurant',
          reservationNotifyAudience: 'owner',
          reservationNotifyCustomEmail: null,
          reservationNotifyRecipients: null,
          reservationNotifyOnWeb: true,
          reservationNotifyOnManual: true,
          owner: { id: 'owner-user', email: 'Owner@Test.com', name: 'Ana', lastName: 'López' },
        };
      }
      return origOrgFind(args);
    };

    try {
      const emails = await api.resolveReservationNotifyEmails('org-1', 'rest-new');
      assert.deepEqual(emails, ['owner@test.com']);
    } finally {
      prisma.restaurant.findUnique = origRestaurantFind;
      prisma.restaurantOrganization.findUnique = origOrgFind;
    }
  });

  it('buildInitialRestaurantNotifyRecipients enables owner and assigned team', async () => {
    const config = await api.buildInitialRestaurantNotifyRecipients('org-1', 'rest-1');
    assert.equal(config.owner, true);
    assert.equal(config.members['mgr-1'], true);
    assert.equal(config.members['host-1'], true);
    assert.deepEqual(config.extras, []);
  });
});
