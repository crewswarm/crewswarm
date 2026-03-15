#!/usr/bin/env node
/**
 * CrewSwarm Studio Watch Server
 * WebSocket server for CLI → Studio file change broadcasts
 * 
 * Listens on ws://127.0.0.1:3334/ws
 * CLI connects and broadcasts file changes
 * Studio UI connects and receives live updates
 * 
 * Usage:
 *   node apps/vibe/watch-server.mjs
 *   Or: npm run studio:watch
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';

const PORT = process.env.STUDIO_WATCH_PORT || 3334;

// Create HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      uptime: process.uptime()
    }));
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server
const wss = new WebSocketServer({ 
  server: httpServer,
  path: '/ws'
});

// Track connected clients
const clients = new Set();

wss.on('connection', (ws, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[${new Date().toISOString()}] Client connected: ${clientId}`);
  clients.add(ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Broadcast to all OTHER clients (not sender)
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) { // 1 = OPEN
          client.send(JSON.stringify(msg));
        }
      });
      
      // Log file changes
      if (msg.type === 'file-changed') {
        console.log(`[${new Date().toISOString()}] 📝 ${msg.path}`);
      } else if (msg.type === 'file-created') {
        console.log(`[${new Date().toISOString()}] ✨ ${msg.path}`);
      } else if (msg.type === 'file-deleted') {
        console.log(`[${new Date().toISOString()}] 🗑️  ${msg.path}`);
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected: ${clientId}`);
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] WebSocket error:`, err);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to Studio watch server',
    clients: wss.clients.size
  }));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`🔗 Studio Watch Server running:`);
  console.log(`   WebSocket: ws://127.0.0.1:${PORT}/ws`);
  console.log(`   Health: http://127.0.0.1:${PORT}/health`);
  console.log('');
  console.log('Waiting for CLI and Studio connections...');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  wss.close(() => {
    httpServer.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});
