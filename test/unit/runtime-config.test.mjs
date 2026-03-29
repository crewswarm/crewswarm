/**
 * Unit tests for lib/runtime/config.mjs
 *
 * Covers:
 *  - loadSystemConfig: returns object (possibly empty) without crashing
 *  - loadSwarmConfig: returns object (possibly empty) without crashing
 *  - loadAgentList: returns an array
 *  - PROVIDER_REGISTRY: contains expected providers with baseUrl
 *  - resolveProviderConfig: merges explicit + built-in configs
 *  - CREWSWARM_DIR / CREWSWARM_CONFIG_PATH: correct path shapes
 *  - PROTOCOL_VERSION / CLI_VERSION: expected types
 *  - loadCursorWavesEnabled / loadClaudeCodeEnabled: return booleans
 *  - env var driven constants: CREWSWARM_RT_URL, CREWSWARM_RT_RECONNECT_MS, etc.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import {
  loadSystemConfig,
  loadSwarmConfig,
  loadAgentList,
  resolveProvider,
  resolveProviderConfig,
  PROVIDER_REGISTRY,
  CREWSWARM_DIR,
  CREWSWARM_CONFIG_PATH,
  CREWSWARM_SWARM_PATH,
  CREWSWARM_REPO_ROOT,
  PROTOCOL_VERSION,
  CLI_VERSION,
  CREWSWARM_RT_URL,
  CREWSWARM_RT_RECONNECT_MS,
  CREWSWARM_RT_DISPATCH_ENABLED,
  MEMORY_PROTOCOL_MARKER,
  RUN_ID,
  CREW_LEAD_PORT,
  loadCursorWavesEnabled,
  loadClaudeCodeEnabled,
  loadTmuxBridgeEnabled,
} from '../../lib/runtime/config.mjs';

describe('runtime/config — path constants', () => {
  it('CREWSWARM_DIR points to ~/.crewswarm', () => {
    assert.equal(CREWSWARM_DIR, path.join(os.homedir(), '.crewswarm'));
  });

  it('CREWSWARM_CONFIG_PATH ends with config.json', () => {
    assert.ok(CREWSWARM_CONFIG_PATH.endsWith('config.json'));
  });

  it('CREWSWARM_SWARM_PATH ends with crewswarm.json', () => {
    assert.ok(CREWSWARM_SWARM_PATH.endsWith('crewswarm.json'));
  });

  it('CREWSWARM_REPO_ROOT is an absolute path', () => {
    assert.ok(path.isAbsolute(CREWSWARM_REPO_ROOT));
  });
});

describe('runtime/config — loadSystemConfig', () => {
  it('returns an object', () => {
    const cfg = loadSystemConfig();
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg !== null);
  });
});

describe('runtime/config — loadSwarmConfig', () => {
  it('returns an object', () => {
    const cfg = loadSwarmConfig();
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg !== null);
  });
});

describe('runtime/config — loadAgentList', () => {
  it('returns an array', () => {
    const agents = loadAgentList();
    assert.ok(Array.isArray(agents));
  });

  it('each agent has an id field if any agents exist', () => {
    const agents = loadAgentList();
    for (const agent of agents) {
      assert.ok(agent.id, `agent should have an id: ${JSON.stringify(agent)}`);
    }
  });
});

describe('runtime/config — PROVIDER_REGISTRY', () => {
  it('is an object with known providers', () => {
    assert.equal(typeof PROVIDER_REGISTRY, 'object');
    const expectedProviders = ['groq', 'openai', 'anthropic', 'google', 'deepseek', 'ollama'];
    for (const key of expectedProviders) {
      assert.ok(PROVIDER_REGISTRY[key], `should have provider: ${key}`);
    }
  });

  it('each provider has a baseUrl (string or null)', () => {
    for (const [key, value] of Object.entries(PROVIDER_REGISTRY)) {
      assert.ok(
        typeof value.baseUrl === 'string' || value.baseUrl === null,
        `${key}.baseUrl should be string or null`
      );
    }
  });

  it('groq baseUrl points to groq API', () => {
    assert.match(PROVIDER_REGISTRY.groq.baseUrl, /groq\.com/);
  });

  it('ollama baseUrl defaults to localhost', () => {
    assert.match(PROVIDER_REGISTRY.ollama.baseUrl, /localhost/);
  });

  it('openai-compatible has null baseUrl (user must supply)', () => {
    assert.equal(PROVIDER_REGISTRY['openai-compatible'].baseUrl, null);
  });
});

describe('runtime/config — resolveProviderConfig', () => {
  it('returns built-in config when no explicit config provided', () => {
    const result = resolveProviderConfig({}, 'groq');
    assert.ok(result, 'should return a config');
    assert.match(result.baseUrl, /groq\.com/);
    assert.equal(result.apiKey, null, 'apiKey should be null without explicit config');
  });

  it('returns null for unknown provider with no explicit config', () => {
    const result = resolveProviderConfig({}, 'nonexistent-provider-xyz');
    assert.equal(result, null);
  });

  it('merges explicit config over built-in', () => {
    const cfg = {
      providers: {
        groq: { apiKey: 'test-key-123' }
      }
    };
    const result = resolveProviderConfig(cfg, 'groq');
    assert.ok(result);
    assert.match(result.baseUrl, /groq\.com/, 'should use built-in baseUrl');
    assert.equal(result.apiKey, 'test-key-123', 'should use explicit apiKey');
  });

  it('uses explicit baseUrl when provided', () => {
    const cfg = {
      providers: {
        groq: { baseUrl: 'http://custom.groq.local/v1', apiKey: 'key' }
      }
    };
    const result = resolveProviderConfig(cfg, 'groq');
    assert.equal(result.baseUrl, 'http://custom.groq.local/v1');
  });

  it('falls back to env key convention for apiKey', () => {
    const cfg = {
      env: { GROQ_API_KEY: 'env-key-456' }
    };
    const result = resolveProviderConfig(cfg, 'groq');
    assert.equal(result.apiKey, 'env-key-456');
  });
});

describe('runtime/config — resolveProvider', () => {
  it('returns null for unknown provider', () => {
    const result = resolveProvider('nonexistent-provider-xyz');
    assert.equal(result, null);
  });
});

describe('runtime/config — version and misc constants', () => {
  it('PROTOCOL_VERSION is a number', () => {
    assert.equal(typeof PROTOCOL_VERSION, 'number');
    assert.ok(PROTOCOL_VERSION >= 1);
  });

  it('CLI_VERSION is a semver-like string', () => {
    assert.match(CLI_VERSION, /^\d+\.\d+\.\d+/);
  });

  it('RUN_ID is a UUID string', () => {
    assert.match(RUN_ID, /^[0-9a-f-]{36}$/);
  });

  it('CREWSWARM_RT_URL is a string', () => {
    assert.equal(typeof CREWSWARM_RT_URL, 'string');
  });

  it('CREWSWARM_RT_RECONNECT_MS is a number', () => {
    assert.equal(typeof CREWSWARM_RT_RECONNECT_MS, 'number');
  });

  it('CREWSWARM_RT_DISPATCH_ENABLED is a boolean', () => {
    assert.equal(typeof CREWSWARM_RT_DISPATCH_ENABLED, 'boolean');
  });

  it('MEMORY_PROTOCOL_MARKER is a non-empty string', () => {
    assert.equal(typeof MEMORY_PROTOCOL_MARKER, 'string');
    assert.ok(MEMORY_PROTOCOL_MARKER.length > 0);
  });

  it('CREW_LEAD_PORT is a number', () => {
    assert.equal(typeof CREW_LEAD_PORT, 'number');
  });
});

describe('runtime/config — feature flag loaders', () => {
  it('loadCursorWavesEnabled returns a boolean', () => {
    const result = loadCursorWavesEnabled();
    assert.equal(typeof result, 'boolean');
  });

  it('loadClaudeCodeEnabled returns a boolean', () => {
    const result = loadClaudeCodeEnabled();
    assert.equal(typeof result, 'boolean');
  });

  it('loadTmuxBridgeEnabled returns a boolean', () => {
    const result = loadTmuxBridgeEnabled();
    assert.equal(typeof result, 'boolean');
  });
});
