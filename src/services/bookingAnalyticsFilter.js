const prisma = require('../lib/prisma');

/**
 * Resuelve filtro de restaurantes para booking analytics.
 * @returns {Promise<{ error?: string, status?: number, restaurantFilter?: object, filterContext: object }>}
 */
async function resolveBookingAnalyticsFilter({ organizationId, restaurantId }) {
  const filterContext = {
    organizationId: null,
    organizationName: null,
    restaurantId: null,
    restaurantName: null,
    restaurantCount: 0,
  };

  const orgId = organizationId && String(organizationId).trim();
  const restId = restaurantId && String(restaurantId).trim();

  if (!orgId && !restId) {
    const total = await prisma.restaurant.count({ where: { isDeleted: false } });
    filterContext.restaurantCount = total;
    return { restaurantFilter: {}, filterContext };
  }

  if (orgId && restId) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { id: restId, organizationId: orgId, isDeleted: false },
      select: { id: true, name: true, organizationId: true, organization: { select: { name: true } } },
    });
    if (!restaurant) {
      return { error: 'El local no pertenece a la organización indicada', status: 400 };
    }
    filterContext.organizationId = orgId;
    filterContext.organizationName = restaurant.organization?.name ?? null;
    filterContext.restaurantId = restId;
    filterContext.restaurantName = restaurant.name;
    filterContext.restaurantCount = 1;
    return { restaurantFilter: { restaurantId: restId }, filterContext };
  }

  if (restId) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { id: restId, isDeleted: false },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });
    if (!restaurant) {
      return { error: 'Local no encontrado', status: 404 };
    }
    filterContext.organizationId = restaurant.organizationId;
    filterContext.organizationName = restaurant.organization?.name ?? null;
    filterContext.restaurantId = restId;
    filterContext.restaurantName = restaurant.name;
    filterContext.restaurantCount = 1;
    return { restaurantFilter: { restaurantId: restId }, filterContext };
  }

  const org = await prisma.restaurantOrganization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });
  if (!org) {
    return { error: 'Organización no encontrada', status: 404 };
  }

  const restaurants = await prisma.restaurant.findMany({
    where: { organizationId: orgId, isDeleted: false },
    select: { id: true },
  });
  const ids = restaurants.map((r) => r.id);

  filterContext.organizationId = orgId;
  filterContext.organizationName = org.name;
  filterContext.restaurantCount = ids.length;

  if (ids.length === 0) {
    return { restaurantFilter: { restaurantId: { in: ['__none__'] } }, filterContext };
  }

  return { restaurantFilter: { restaurantId: { in: ids } }, filterContext };
}

module.exports = { resolveBookingAnalyticsFilter };
