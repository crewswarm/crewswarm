const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.json());

// Authentication routes
const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});