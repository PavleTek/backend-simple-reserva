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

    if (req.user.role === 'super_admin') {
      req.activeRestaurant = { restaurantId, role: 'owner' };
      next();
      return;
    }

    const userRestaurant = await prisma.userRestaurant.findUnique({
      where: {
        userId_restaurantId: { userId: req.user.id, restaurantId },
      },
      select: { role: true },
    });

    if (!userRestaurant) {
      res.status(403).json({ error: 'No tienes acceso a este restaurante' });
      return;
    }

    req.activeRestaurant = { restaurantId, role: userRestaurant.role };
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
