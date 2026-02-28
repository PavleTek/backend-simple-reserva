const prisma = require('../lib/prisma');
const { extractTokenFromHeader, verifyToken } = require('../utils/jwt');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    const token = extractTokenFromHeader(authHeader);
    const decoded = verifyToken(token);

    if (decoded.isTempToken) {
      res.status(401).json({ error: 'Temporary tokens are not accepted for this endpoint' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      lastName: user.lastName,
      role: user.role,
      restaurantId: user.restaurantId,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
    };

    next();
  } catch (error) {
    if (error instanceof Error) {
      res.status(401).json({ error: error.message });
    } else {
      res.status(401).json({ error: 'Invalid token' });
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
        restaurantId: user.restaurantId,
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
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const hasRequiredRole = allowedRoles.includes(req.user.role);

    if (!hasRequiredRole) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: allowedRoles,
        userRole: req.user.role
      });
      return;
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  optionalAuth,
  authenticateRoles
};
