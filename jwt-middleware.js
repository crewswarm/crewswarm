import jwt from 'jsonwebtoken';

/**
 * JWT validation middleware
 * Validates JWT token from Authorization header
 * @param {Object} options - Configuration options
 * @param {string} options.secret - JWT secret key
 * @param {string[]} options.publicRoutes - Routes that bypass authentication
 * @returns {Function} Express middleware
 */
export function validateJwt({ secret, publicRoutes = [] }) {
  return async (req, res, next) => {
    try {
      // Skip authentication for public routes
      if (publicRoutes.includes(req.path)) {
        return next();
      }

      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
          error: 'Missing or invalid authorization header' 
        });
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      
      // Verify and decode token
      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch (jwtError) {
        if (jwtError.name === 'TokenExpiredError') {
          return res.status(401).json({ error: 'Token has expired' });
        }
        if (jwtError.name === 'JsonWebTokenError') {
          return res.status(401).json({ error: 'Invalid token' });
        }
        throw jwtError;
      }

      // Validate required claims
      if (!decoded.sub || !decoded.exp) {
        return res.status(401).json({ 
          error: 'Token missing required claims' 
        });
      }

      // Attach user info to request
      req.user = {
        id: decoded.sub,
        email: decoded.email,
        roles: decoded.roles || [],
        scope: decoded.scope || []
      };

      next();
    } catch (error) {
      console.error('JWT validation error:', error);
      res.status(500).json({ 
        error: 'Authentication validation failed' 
      });
    }
  };
}

/**
 * Role-based authorization middleware
 * @param {string|string[]} requiredRoles - Required role(s)
 * @returns {Function} Express middleware
 */
export function requireRole(requiredRoles) {
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hasRole = req.user.roles.some(role => roles.includes(role));
    if (!hasRole) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: roles,
        userRoles: req.user.roles
      });
    }

    next();
  };
}

/**
 * Scope-based authorization middleware
 * @param {string|string[]} requiredScopes - Required scope(s)
 * @returns {Function} Express middleware
 */
export function requireScope(requiredScopes) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hasScope = req.user.scope.some(scope => scopes.includes(scope));
    if (!hasScope) {
      return res.status(403).json({ 
        error: 'Insufficient scope permissions',
        required: scopes,
        userScopes: req.user.scope
      });
    }

    next();
  };
}
