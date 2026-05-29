'use strict';

const prisma = require('../../lib/prisma');

async function listAddons(organizationId) {
  return prisma.subscriptionAddon.findMany({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function addAddon({ organizationId, subscriptionId, addonType, quantity, priceCLP }) {
  return prisma.subscriptionAddon.create({
    data: {
      organizationId,
      subscriptionId: subscriptionId || null,
      addonType,
      quantity: quantity || 1,
      priceCLP,
    },
  });
}

module.exports = {
  listAddons,
  addAddon,
};
