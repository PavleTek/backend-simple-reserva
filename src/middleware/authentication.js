const prisma = require('../lib/prisma');
const { extractTokenFromHeader, verifyToken } = require('../utils/jwt');

/** Solo lo que req.user expone. No trae hash, 2FA ni códigos de reset. */
const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  lastName: true,
  role: true,
  lastLogin: true,
  createdAt: true,
  dashboardTourCompletedAt: true,
};

function toRequestUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    lastName: user.lastName,
    role: user.role,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
    dashboardTourCompletedAt: user.dashboardTourCompletedAt,
  };
}

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Se requiere token de acceso' });
      return;
    }

    const token = extractTokenFromHeader(authHeader);
    const decoded = verifyToken(token);

    if (decoded.isTempToken) {
      res.status(401).json({ error: 'Los tokens temporales no son válidos para este endpoint' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: AUTH_USER_SELECT,
    });

    if (!user) {
      res.status(401).json({ error: 'Usuario no encontrado' });
      return;
    }

    req.user = toRequestUser(user);

    next();
  } catch (error) {
    if (error instanceof Error) {
      res.status(401).json({ error: error.message });
    } else {
      res.status(401).json({ error: 'Token inválido' });
    }
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      next();
      return;
    }

    const token = extractTokenFromHeader(authHeader);
    const decoded = verifyToken(token);

    if (decoded.isTempToken) {
      next();
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: AUTH_USER_SELECT,
    });

    if (user) {
      req.user = toRequestUser(user);
    }

    next();
  } catch (error) {
    next();
  }
};

const authenticateRoles = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Autenticación requerida' });
      return;
    }

    const hasRequiredRole = allowedRoles.includes(req.user.role);

    if (!hasRequiredRole) {
      res.status(403).json({
        error: 'Permisos insuficientes',
        required: allowedRoles,
        userRole: req.user.role
      });
      return;
    }

    next();
  };
};

const authorizeRestaurant = async (req, res, next) => {
  try {
    const restaurantId = req.params.restaurantId;
    if (!restaurantId) {
      res.status(400).json({ error: 'Restaurant ID es requerido' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Autenticación requerida' });
      return;
    }

    // 1. Super Admin access
    if (req.user.role === 'super_admin') {
      req.activeRestaurant = { restaurantId, role: 'restaurant_owner' };
      next();
      return;
    }

    // Una sola sentencia: dueño, luego encargado, luego anfitrión. Mismo orden que antes.
    const rows = await prisma.$queryRaw`
      SELECT CASE
        WHEN o."ownerId" = ${req.user.id} THEN 'restaurant_owner'
        WHEN EXISTS (
          SELECT 1
          FROM "ManagerRestaurantAssignment" m
          INNER JOIN "OrganizationManager" om ON om."id" = m."organizationManagerId"
          WHERE m."restaurantId" = r."id" AND om."userId" = ${req.user.id}
        ) THEN 'restaurant_manager'
        WHEN EXISTS (
          SELECT 1
          FROM "HostRestaurantAssignment" h
          INNER JOIN "OrganizationHost" oh ON oh."id" = h."organizationHostId"
          WHERE h."restaurantId" = r."id" AND oh."userId" = ${req.user.id}
        ) THEN 'restaurant_host'
        ELSE NULL
      END AS role
      FROM "Restaurant" r
      INNER JOIN "RestaurantOrganization" o ON o."id" = r."organizationId"
      WHERE r."id" = ${restaurantId} AND r."isDeleted" = false
      LIMIT 1
    `;
    const role = rows[0]?.role;
    if (!role) {
      res.status(403).json({ error: 'No tienes acceso a este restaurante' });
      return;
    }

    req.activeRestaurant = { restaurantId, role };
    next();
  } catch (error) {
    next(error);
  }
};

const authenticateRestaurantRoles = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.activeRestaurant) {
      res.status(403).json({ error: 'Acceso al restaurante no autorizado' });
      return;
    }
    const hasRequiredRole = allowedRoles.includes(req.activeRestaurant.role);
    if (!hasRequiredRole) {
      res.status(403).json({
        error: 'Permisos insuficientes para esta acción',
        required: allowedRoles,
        userRole: req.activeRestaurant.role,
      });
      return;
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  optionalAuth,
  authenticateRoles,
  authorizeRestaurant,
  authenticateRestaurantRoles,
};
