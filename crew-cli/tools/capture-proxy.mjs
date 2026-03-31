#!/usr/bin/env node
/**
 * HTTP capture proxy — sits between crew-cli and the Anthropic API.
 * Logs every request's headers and body to see exactly what gets sent.
 *
 * Usage:
 *   node tools/capture-proxy.mjs
 *   # Then in another terminal:
 *   ANTHROPIC_BASE_URL=http://localhost:9999 claude "hi"
 *   # Or test with crew-cli
 */

import http from 'node:http';
import https from 'node:https';

const PORT = 9999;
const TARGET = 'https://api.anthropic.com';

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  console.log('\n' + '='.repeat(80));
  console.log(`${req.method} ${req.url}`);
  console.log('-'.repeat(40) + ' HEADERS ' + '-'.repeat(31));
  for (const [key, value] of Object.entries(req.headers)) {
    // Redact tokens but show structure
    const v = String(value);
    const display = (key === 'authorization' || key === 'x-api-key')
      ? v.slice(0, 30) + '...[REDACTED]'
      : v;
    console.log(`  ${key}: ${display}`);
  }
  console.log('-'.repeat(40) + ' BODY ' + '-'.repeat(34));
  try {
    const parsed = JSON.parse(body);
    // Show body but truncate messages content
    const display = { ...parsed };
    if (display.messages) {
      display.messages = display.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 100) + '...' : '[complex]'
      }));
    }
    if (display.system) {
      display.system = typeof display.system === 'string'
        ? display.system.slice(0, 100) + '...'
        : '[complex]';
    }
    console.log(JSON.stringify(display, null, 2));
  } catch {
    console.log(body.slice(0, 500));
  }
  console.log('='.repeat(80));

  // Forward to real API
  const url = new URL(req.url, TARGET);
  const headers = { ...req.headers, host: url.host };

  const proxyReq = https.request(url, {
    method: req.method,
    headers,
  }, (proxyRes) => {
    const respChunks = [];
    proxyRes.on('data', c => respChunks.push(c));
    proxyRes.on('end', () => {
      const respBody = Buffer.concat(respChunks).toString();
      console.log(`\n  RESPONSE: ${proxyRes.statusCode}`);
      console.log(`  ${respBody.slice(0, 300)}`);

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(respBody);
    });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502);
    res.end('Proxy error');
  });

  proxyReq.end(body);
});

server.listen(PORT, () => {
  console.log(`Capture proxy listening on http://localhost:${PORT}`);
  console.log(`Set ANTHROPIC_BASE_URL=http://localhost:${PORT} to capture Claude Code traffic`);
  console.log('Press Ctrl+C to stop\n');
});
