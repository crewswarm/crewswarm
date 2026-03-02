#!/usr/bin/env node
/**
 * Bootstrap ~/.crewswarm config directory on first run
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CREWSWARM_DIR = path.join(os.homedir(), '.crewswarm');

console.log('[bootstrap] Creating CrewSwarm config directory...');

// Create directory structure
const dirs = [
    CREWSWARM_DIR,
    path.join(CREWSWARM_DIR, 'skills'),
    path.join(CREWSWARM_DIR, 'logs'),
    path.join(CREWSWARM_DIR, 'shared-memory'),
    path.join(CREWSWARM_DIR, 'shared-memory', '.crew'),
    path.join(CREWSWARM_DIR, 'shared-memory', '.crew', 'agent-memory'),
    path.join(CREWSWARM_DIR, 'shared-memory', '.crew', 'collections'),
];

for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[bootstrap] Created ${dir}`);
    }
}

// Generate RT auth token
const authToken = crypto.randomBytes(32).toString('hex');

// Create config.json (RT auth)
const configPath = path.join(CREWSWARM_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
    const config = {
        rt: {
            authToken,
            url: 'ws://127.0.0.1:18889'
        }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('[bootstrap] Created config.json');
}

// Create crewswarm.json (agent models and API keys)
const crewswarmConfigPath = path.join(CREWSWARM_DIR, 'crewswarm.json');
if (!fs.existsSync(crewswarmConfigPath)) {
    const crewswarmConfig = {
        agents: [
            { id: 'knowledge-agent', model: 'groq/llama-3.3-70b-versatile', engine: 'direct' },
            { id: 'mcp-agent', model: 'groq/llama-3.3-70b-versatile', engine: 'direct' },
            { id: 'assistant-agent', model: 'groq/llama-3.3-70b-versatile', engine: 'direct' },
            { id: 'crew-lead', model: 'groq/llama-3.3-70b-versatile', engine: 'direct' }
        ],
        providers: {
            groq: { apiKey: process.env.GROQ_API_KEY || '' },
            openai: { apiKey: process.env.OPENAI_API_KEY || '' },
            anthropic: { apiKey: process.env.ANTHROPIC_API_KEY || '' },
            mistral: { apiKey: process.env.MISTRAL_API_KEY || '' },
            deepseek: { apiKey: process.env.DEEPSEEK_API_KEY || '' }
        },
        env: {}
    };
    fs.writeFileSync(crewswarmConfigPath, JSON.stringify(crewswarmConfig, null, 2));
    console.log('[bootstrap] Created crewswarm.json');
}

// Create cmd-allowlist.json
const allowlistPath = path.join(CREWSWARM_DIR, 'cmd-allowlist.json');
if (!fs.existsSync(allowlistPath)) {
    const allowlist = {
        patterns: [
            'ls -la',
            'pwd',
            'git status',
            'git log',
            'git diff',
            'npm --version',
            'node --version'
        ]
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
    console.log('[bootstrap] Created cmd-allowlist.json');
}

// Create AgentKeeper log
const keeperPath = path.join(CREWSWARM_DIR, 'shared-memory', '.crew', 'agentkeeper.jsonl');
if (!fs.existsSync(keeperPath)) {
    fs.writeFileSync(keeperPath, '');
    console.log('[bootstrap] Created agentkeeper.jsonl');
}

console.log('[bootstrap] ✓ Config directory ready');
