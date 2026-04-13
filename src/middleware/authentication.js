const prisma = require('../lib/prisma');
const { extractTokenFromHeader, verifyToken } = require('../utils/jwt');

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
    });

    if (!user) {
      res.status(401).json({ error: 'Usuario no encontrado' });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      lastName: user.lastName,
      role: user.role,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      dashboardTourCompletedAt: user.dashboardTourCompletedAt,
    };

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
    });

    if (user) {
      req.user = {
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

    // 2. Owner access (via RestaurantOrganization)
    const ownedRestaurant = await prisma.restaurant.findFirst({
      where: {
        id: restaurantId,
        organization: { ownerId: req.user.id }
      }
    });

    if (ownedRestaurant) {
      req.activeRestaurant = { restaurantId, role: 'restaurant_owner' };
      next();
      return;
    }

    // 3. Manager access (via OrganizationManager and ManagerRestaurantAssignment)
    const managerAssignment = await prisma.managerRestaurantAssignment.findFirst({
      where: {
        restaurantId,
        organizationManager: { userId: req.user.id }
      }
    });

    if (managerAssignment) {
      req.activeRestaurant = { restaurantId, role: 'restaurant_manager' };
      next();
      return;
    }

    res.status(403).json({ error: 'No tienes acceso a este restaurante' });
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
