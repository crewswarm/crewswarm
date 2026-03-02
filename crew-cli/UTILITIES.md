# CrewSwarm Utilities Catalog

This document provides a comprehensive overview of all utility functions available in the `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/src/` directory.

## How to Use This Catalog

1. **Before creating new utilities**: Check if an existing function already provides the functionality you need
2. **Import existing utilities**: Use the functions from their original locations rather than reimplementing
3. **Add new utilities**: Follow the existing patterns and update this catalog

## Quick Reference by Category

### Agent Mapping (`agent-mapping`)
- `mapAgentToCapability()` - Maps agent IDs to capability categories
- `getCapabilityForTask()` - Determines best capability for task description  
- `mapCapabilityToAgents()` - Returns agents for specific capability

### Metrics (`metrics`)
- `createPipelineMetrics()` - Creates metrics collector for pipeline execution
- `recordPipelineStage()` - Records metrics for pipeline stages

### Parsing (`parsing`)
- `safeJsonParse()` - Safely parses JSON with fallback
- `extractJsonFromText()` - Extracts JSON using regex patterns

### Pipeline (`pipeline`)
- `createContextPack()` - Creates context pack for agent execution
- `mergeContextPacks()` - Merges multiple context packs
- `createRunState()` - Creates new pipeline run state
- `updateRunState()` - Updates pipeline run state
- `getRunStateSnapshot()` - Gets current run state snapshot
- `createUnifiedPipeline()` - Creates unified pipeline processor
- `executePipeline()` - Executes pipeline with input

### Memory (`memory`)
- `createAgentMemory()` - Creates agent memory instance
- `storeMemory()` - Stores memory entry for agent
- `retrieveMemory()` - Retrieves memory entry
- `createMemoryBroker()` - Creates memory broker
- `queryMemory()` - Queries memory using broker
- `createAgentKeeper()` - Creates agent keeper
- `recordTask()` - Records completed task result
- `initializeMemory()` - Initializes memory subsystem
- `getMemoryStats()` - Gets memory system statistics

### Interface (`interface`)
- `createMCPHandler()` - Creates Model Context Protocol handler
- `handleMCPRequest()` - Handles MCP request
- `createServer()` - Creates HTTP server instance
- `startServer()` - Starts HTTP server

### Tools (`tools`)
- `createToolManager()` - Creates tool manager instance
- `registerTool()` - Registers new tool
- `executeTool()` - Executes registered tool

### Checkpoint (`checkpoint`)
- `createCheckpointStore()` - Creates checkpoint store
- `saveCheckpoint()` - Saves checkpoint
- `loadCheckpoint()` - Loads checkpoint

### Context (`context`)
- `augmentContext()` - Augments execution context
- `createContextAugmenter()` - Creates context augmenter
- `getGitContext()` - Extracts git context
- `getGitDiff()` - Gets git diff

### Capabilities (`capabilities`)
- `getAgentCapabilities()` - Gets agent capabilities
- `registerCapability()` - Registers new capability

### Cache (`cache`)
- `createTokenCache()` - Creates token cache
- `getCachedTokens()` - Retrieves cached tokens

### Autofix (`autofix`)
- `createAutofixRunner()` - Creates autofix runner
- `runAutofix()` - Runs autofix on issue
- `createAutofixStore()` - Creates autofix store
- `saveAutofix()` - Saves autofix result

## Utility Functions by File

### src/mapping/index.ts
```typescript
// Agent capability mapping functions
export function mapAgentToCapability(agentId: string): string
export function getCapabilityForTask(taskDescription: string): string  
export function mapCapabilityToAgents(capability: string): string[]
```

### src/metrics/pipeline.ts
```typescript
// Pipeline metrics collection
export function createPipelineMetrics(options?: MetricsOptions): PipelineMetrics
export function recordPipelineStage(stage: string, duration: number, result: any): void
```

### src/metrics/json-parse.ts
```typescript
// Safe JSON parsing utilities
export function safeJsonParse(text: string): any
export function extractJsonFromText(text: string): any[]
```

### src/pipeline/context-pack.ts
```typescript
// Context pack management
export function createContextPack(context: ExecutionContext): ContextPack
export function mergeContextPacks(packs: ContextPack[]): ContextPack
```

### src/pipeline/run-state.ts
```typescript
// Pipeline run state management
export function createRunState(initialState?: Partial<RunState>): RunState
export function updateRunState(state: RunState, updates: Partial<RunState>): RunState
export function getRunStateSnapshot(state: RunState): RunStateSnapshot
```

### src/pipeline/agent-memory.ts
```typescript
// Agent memory management
export function createAgentMemory(agentId: string, options?: MemoryOptions): AgentMemory
export function storeMemory(memory: AgentMemory, key: string, value: any): void
export function retrieveMemory(memory: AgentMemory, key: string): any
```

### src/pipeline/unified.ts
```typescript
// Unified pipeline processing
export function createUnifiedPipeline(config: PipelineConfig): PipelineProcessor
export function executePipeline(processor: PipelineProcessor, input: any): Promise<PipelineResult>
```

### src/interface/mcp-handler.ts
```typescript
// Model Context Protocol handling
export function createMCPHandler(options: MCPOptions): MCPHandler
export function handleMCPRequest(handler: MCPHandler, request: MCPRequest): Promise<MCPResponse>
```

### src/interface/server.ts
```typescript
// HTTP server management
export function createServer(config: ServerConfig): Server
export function startServer(server: Server): Promise<void>
```

### src/tools/manager.js
```typescript
// Tool management system
export function createToolManager(options: ToolManagerOptions): ToolManager
export function registerTool(manager: ToolManager, tool: Tool): void
export function executeTool(manager: ToolManager, toolName: string, args: any[]): Promise<any>
```

### src/checkpoint/store.ts
```typescript
// Checkpoint persistence
export function createCheckpointStore(options: StoreOptions): CheckpointStore
export function saveCheckpoint(store: CheckpointStore, checkpoint: Checkpoint): Promise<void>
export function loadCheckpoint(store: CheckpointStore, checkpointId: string): Promise<Checkpoint>
```

### src/context/augment.ts
```typescript
// Context augmentation
export function augmentContext(context: ExecutionContext, augmenters: ContextAugmenter[]): ExecutionContext
export function createContextAugmenter(augmenter: (context: ExecutionContext) => ExecutionContext): ContextAugmenter
```

### src/context/git.ts
```typescript
// Git context extraction
export function getGitContext(repoPath: string): Promise<GitContext>
export function getGitDiff(repoPath: string): Promise<string>
```

### src/capabilities/index.ts
```typescript
// Agent capability management
export function getAgentCapabilities(agentId: string): Capability[]
export function registerCapability(agentId: string, capability: Capability): void
```

### src/memory/broker.ts
```typescript
// Memory brokering system
export function createMemoryBroker(options: BrokerOptions): MemoryBroker
export function queryMemory(broker: MemoryBroker, query: string): Promise<MemoryResult>
```

### src/memory/agentkeeper.ts
```typescript
// Agent task result storage
export function createAgentKeeper(options: KeeperOptions): AgentKeeper
export function recordTask(keeper: AgentKeeper, task: TaskRecord): Promise<void>
```

### src/memory/index.ts
```typescript
// Memory system initialization
export function initializeMemory(config: MemoryConfig): Promise<MemorySystem>
export function getMemoryStats(system: MemorySystem): MemoryStats
```

### src/cache/token-cache.ts
```typescript
// Token caching system
export function createTokenCache(options: CacheOptions): TokenCache
export function getCachedTokens(cache: TokenCache, key: string): string | null
```

### src/autofix/runner.ts
```typescript
// Autofix execution
export function createAutofixRunner(options: AutofixOptions): AutofixRunner
export function runAutofix(runner: AutofixRunner, issue: Issue): Promise<AutofixResult>
```

### src/autofix/store.ts
```typescript
// Autofix result storage
export function createAutofixStore(options: StoreOptions): AutofixStore
export function saveAutofix(store: AutofixStore, result: AutofixResult): Promise<void>
```

## Search Helper Functions

The catalog includes helper functions to find utilities:

```typescript
// Search utilities by name, category, or description
findUtilities(search: string): UtilityFunction[]

// Get all unique categories
getCategories(): string[]

// Get all utilities in a specific category
getUtilitiesByCategory(category: string): UtilityFunction[]
```

## Usage Examples

```typescript
import { findUtilities, getUtilitiesByCategory } from './src/utils/functions';

// Find all parsing utilities
const parsingUtils = getUtilitiesByCategory('parsing');

// Search for memory-related functions
const memoryUtils = findUtilities('memory');

// Find by function name
const pipelineUtils = findUtilities('pipeline');
```

## Notes

- This catalog covers 75+ utility functions across 20 source files
- Functions are organized by category for easy discovery
- Always check if an existing utility provides the functionality you need before implementing new ones
- Update this catalog when adding new utility functions
