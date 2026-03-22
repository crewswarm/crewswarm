import { Request, Response, NextFunction } from 'express';

/**
 * Stub authentication middleware.
 * In a real app this would verify a JWT or session token.
 * Currently it checks for a Bearer token header but does not validate it.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // For benchmarks: allow requests without auth in development mode
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized: missing Bearer token' });
    return;
  }

  // TODO: Actually validate the token
  const token = authHeader.slice(7);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: empty token' });
    return;
  }

  next();
}
