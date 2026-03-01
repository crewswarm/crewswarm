import jwt from 'jsonwebtoken';

/**
 * Validates a JWT token and returns the decoded payload
 * @param {string} token - The JWT token to validate
 * @param {string} secret - The secret key for verification
 * @returns {Object} - The decoded payload if valid
 * @throws {Error} - If token is invalid, expired, or malformed
 */
export function validateJWT(token, secret) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token must be a non-empty string');
  }
  
  if (!secret || typeof secret !== 'string') {
    throw new Error('Secret must be a non-empty string');
  }

  try {
    // Remove 'Bearer ' prefix if present
    const cleanToken = token.replace(/^Bearer\s+/i, '');
    
    // Verify and decode the token
    const decoded = jwt.verify(cleanToken, secret);
    
    return decoded;
  } catch (error) {
    // Re-throw with more context
    if (error.name === 'TokenExpiredError') {
      throw new Error('JWT token has expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid JWT token');
    } else {
      throw new Error(`JWT validation failed: ${error.message}`);
    }
  }
}

/**
 * Middleware factory for Express.js
 * @param {string} secret - The secret key for verification
 * @returns {Function} - Express middleware function
 */
export function createJWTMiddleware(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('Secret must be a non-empty string');
  }

  return function jwtMiddleware(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization header required' });
      }

      const decoded = validateJWT(authHeader, secret);
      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({ error: error.message });
    }
  };
}
