import express from 'express';
import { usersRouter } from './routes/users.js';
import { healthRouter } from './routes/health.js';
import { authMiddleware } from './middleware/auth.js';
import { logger } from './utils/logger.js';

const app = express();

app.use(express.json());

// Public routes
app.use('/health', healthRouter);

// Protected routes
app.use('/api/users', authMiddleware, usersRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });
}

export { app };
