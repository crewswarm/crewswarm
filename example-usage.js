import express from 'express';
import { validateJwt, requireRole, requireScope } from './jwt-middleware.js';

const app = express();

// JWT validation middleware configuration
const jwtMiddleware = validateJwt({
  secret: process.env.JWT_SECRET || 'your-secret-key',
  publicRoutes: ['/health', '/api/auth/login', '/api/auth/register']
});

// Apply JWT validation to all routes except public ones
app.use(jwtMiddleware);

// Public routes (no authentication required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected routes
app.get('/api/profile', (req, res) => {
  res.json({ 
    user: req.user,
    message: 'Profile data'
  });
});

// Admin only route
app.get('/api/admin/users', requireRole('admin'), (req, res) => {
  res.json({ users: [] });
});

// Scoped route
app.post('/api/documents', requireScope('write'), (req, res) => {
  res.json({ message: 'Document created' });
});

// Multi-role route
app.delete('/api/documents/:id', requireRole(['admin', 'editor']), (req, res) => {
  res.json({ message: 'Document deleted' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
