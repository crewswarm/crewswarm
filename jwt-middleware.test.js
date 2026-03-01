import { validateJwt, requireRole, requireScope } from './jwt-middleware.js';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeEach } from '@jest/globals';

describe('JWT Middleware', () => {
  const mockSecret = 'test-secret-key';
  const validToken = jwt.sign(
    { sub: 'user123', email: 'test@example.com', roles: ['user'], scope: ['read'] },
    mockSecret,
    { expiresIn: '1h' }
  );

  let req, res, next;

  beforeEach(() => {
    req = {
      headers: {},
      path: '/api/test'
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
  });

  describe('validateJwt', () => {
    it('should allow access with valid token', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      const middleware = validateJwt({ secret: mockSecret });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        id: 'user123',
        email: 'test@example.com',
        roles: ['user'],
        scope: ['read']
      });
    });

    it('should reject missing authorization header', async () => {
      const middleware = validateJwt({ secret: mockSecret });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing or invalid authorization header'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should skip authentication for public routes', async () => {
      req.path = '/health';
      const middleware = validateJwt({ 
        secret: mockSecret, 
        publicRoutes: ['/health'] 
      });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should reject expired token', async () => {
      const expiredToken = jwt.sign(
        { sub: 'user123', exp: Math.floor(Date.now() / 1000) - 3600 },
        mockSecret
      );
      req.headers.authorization = `Bearer ${expiredToken}`;
      const middleware = validateJwt({ secret: mockSecret });

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token has expired' });
    });
  });

  describe('requireRole', () => {
    it('should allow access with correct role', () => {
      req.user = { roles: ['admin', 'user'] };
      const middleware = requireRole('admin');

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject access without required role', () => {
      req.user = { roles: ['user'] };
      const middleware = requireRole('admin');

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Insufficient permissions',
        required: ['admin'],
        userRoles: ['user']
      });
    });

    it('should reject access without authentication', () => {
      const middleware = requireRole('admin');

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });
  });
});
