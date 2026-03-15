# Programmatic API

## Unified Endpoint Contract (Recommended)

For dashboard, standalone CLI adapter, and headless integrations, use the versioned OpenAPI spec:

- `docs/openapi.unified.v1.json`

This keeps `connected` and `standalone` modes on the same API envelope.

While `crew-cli` is primarily designed as a command-line tool, its core components are exported as TypeScript modules and can be used programmatically in Node.js applications.

For interface-level API contracts (dashboard-first + standalone/headless), see:

- [API-UNIFIED-v1.md](API-UNIFIED-v1.md)

## Installation

```bash
npm install @crewswarm/crew-cli
```

## Core Modules

### 1. `AgentRouter`

Handles communication with the crewswarm gateway.

```typescript
import { AgentRouter } from '@crewswarm/crew-cli/dist/agent/router.js';
import { ConfigManager } from '@crewswarm/crew-cli/dist/config/manager.js';

const config = new ConfigManager();
const router = new AgentRouter(config, toolManager);

// Dispatch a task
const result = await router.dispatch('crew-coder', 'Write a hello world script');
console.log(result.result);
```

### 2. `Sandbox`

Manages cumulative, speculative diffs.

```typescript
import { Sandbox } from '@crewswarm/crew-cli/dist/sandbox/index.js';

const sandbox = new Sandbox('/path/to/project');
await sandbox.load();

// Add a change
await sandbox.addChange('src/index.ts', 'console.log("Hello Sandbox");');

// Preview changes
console.log(sandbox.preview());

// Apply to disk
await sandbox.apply();
```

### 3. `Orchestrator`

Handles intent detection and routing.

```typescript
import { Orchestrator } from '@crewswarm/crew-cli/dist/orchestrator/index.js';

const orchestrator = new Orchestrator(router, sandbox, sessionManager);
const decision = await orchestrator.route('Implement a new feature');

console.log(decision); // { decision: 'CODE', agent: 'crew-coder' }
```

### 4. `TokenFinder`

Locates local API tokens.

```typescript
import { TokenFinder } from '@crewswarm/crew-cli/dist/auth/token-finder.js';

const finder = new TokenFinder();
const tokens = await finder.findTokens();

console.log(tokens.claude);
```
