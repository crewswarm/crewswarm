#!/usr/bin/env node
/**
 * CrewSwarm Template - Main Application
 * Minimal deployment with sample agents
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getPostgresDb } from '../db/index.mjs';
import { knowledgeAgent } from '../agents/knowledge_agent.mjs';
import { mcpAgent } from '../agents/mcp_agent.mjs';
import { assistantAgent } from '../agents/assistant_agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SWARM_DASH_PORT || '4319');
const HOST = process.env.CREWSWARM_BIND_HOST || '0.0.0.0';

// Agent registry
const AGENTS = new Map([
    [knowledgeAgent.id, knowledgeAgent],
    [mcpAgent.id, mcpAgent],
    [assistantAgent.id, assistantAgent],
]);

// Simple HTTP server
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    try {
        // Health check
        if (url.pathname === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, agents: AGENTS.size }));
            return;
        }
        
        // List agents
        if (url.pathname === '/api/agents' && req.method === 'GET') {
            const agents = Array.from(AGENTS.values()).map(a => ({
                id: a.id,
                name: a.name,
                model: a.model,
                status: 'running'
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, agents }));
            return;
        }
        
        // Chat endpoint
        if (url.pathname === '/api/chat' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
            }
            const { agent_id, message, user_id, session_id } = JSON.parse(body);
            
            const agent = AGENTS.get(agent_id);
            if (!agent) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Agent not found' }));
                return;
            }
            
            const result = await agent.handleMessage(message, { userId: user_id, sessionId: session_id });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
            return;
        }
        
        // Root - Simple HTML UI
        if (url.pathname === '/') {
            const html = `<!DOCTYPE html>
<html>
<head>
    <title>CrewSwarm Template</title>
    <style>
        body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .agent-card { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .status { color: #22c55e; font-weight: bold; }
        input, select { padding: 8px; margin: 5px; width: 200px; }
        button { padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #2563eb; }
        #response { margin-top: 20px; padding: 15px; background: #f9fafb; border-radius: 8px; white-space: pre-wrap; }
    </style>
</head>
<body>
    <h1>🤖 CrewSwarm Template</h1>
    <p>Multi-agent system is <span class="status">running</span></p>
    
    <div id="agents"></div>
    
    <h2>Chat</h2>
    <select id="agentSelect">
        <option value="knowledge-agent">Knowledge Agent</option>
        <option value="mcp-agent">MCP Agent</option>
        <option value="assistant-agent">Assistant</option>
    </select>
    <br>
    <input type="text" id="message" placeholder="Type your message..." style="width: 400px;">
    <button onclick="sendMessage()">Send</button>
    
    <div id="response"></div>
    
    <script>
        async function loadAgents() {
            const res = await fetch('/api/agents');
            const data = await res.json();
            const container = document.getElementById('agents');
            container.innerHTML = '<h2>Available Agents</h2>';
            data.agents.forEach(a => {
                container.innerHTML += \`
                    <div class="agent-card">
                        <strong>\${a.name}</strong> (\${a.id})
                        <br>Model: \${a.model}
                        <br>Status: <span class="status">\${a.status}</span>
                    </div>
                \`;
            });
        }
        
        async function sendMessage() {
            const agent = document.getElementById('agentSelect').value;
            const message = document.getElementById('message').value;
            const responseDiv = document.getElementById('response');
            
            if (!message) return;
            
            responseDiv.textContent = 'Thinking...';
            
            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        agent_id: agent,
                        message: message,
                        user_id: 'demo-user',
                        session_id: 'demo-session'
                    })
                });
                const data = await res.json();
                responseDiv.textContent = data.content || 'No response';
            } catch (e) {
                responseDiv.textContent = 'Error: ' + e.message;
            }
        }
        
        document.getElementById('message').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
        
        loadAgents();
    </script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
            return;
        }
        
        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        
    } catch (error) {
        console.error('[server]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
    }
});

// Start server
async function start() {
    console.log('[crewswarm] Initializing database...');
    await initDatabase();
    
    console.log(`[crewswarm] Starting server on ${HOST}:${PORT}...`);
    server.listen(PORT, HOST, () => {
        console.log(`[crewswarm] ✓ Server running at http://${HOST}:${PORT}`);
        console.log(`[crewswarm] ✓ Agents loaded: ${AGENTS.size}`);
        console.log(`[crewswarm] Dashboard: http://localhost:${PORT}`);
    });
}

start().catch(err => {
    console.error('[crewswarm] Fatal error:', err);
    process.exit(1);
});
