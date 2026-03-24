/**
 * Utility Functions Catalog
 * Auto-generated catalog of all utility functions found in /Users/jeffhobbs/CrewSwarm/crew-cli/src/
 * 
 * This file serves as a central reference for discovering existing utilities
 * to prevent duplicate implementations and aid code reuse.
 */

export interface UtilityFunction {
  name: string;
  file: string;
  description: string;
  parameters?: string[];
  returns?: string;
  category: string;
}

export const utilityFunctions: UtilityFunction[] = [
  // From src/mapping/index.ts
  {
    name: 'mapAgentToCapability',
    file: 'src/mapping/index.ts',
    description: 'Maps agent IDs to their primary capability categories',
    parameters: ['agentId: string'],
    returns: 'string',
    category: 'agent-mapping'
  },
  {
    name: 'getCapabilityForTask',
    file: 'src/mapping/index.ts',
    description: 'Determines the best capability category for a given task description',
    parameters: ['taskDescription: string'],
    returns: 'string',
    category: 'agent-mapping'
  },
  {
    name: 'mapCapabilityToAgents',
    file: 'src/mapping/index.ts',
    description: 'Returns all agents that can handle a specific capability',
    parameters: ['capability: string'],
    returns: 'string[]',
    category: 'agent-mapping'
  },

  // From src/metrics/pipeline.ts
  {
    name: 'createPipelineMetrics',
    file: 'src/metrics/pipeline.ts',
    description: 'Creates a metrics collector for pipeline execution',
    parameters: ['options?: MetricsOptions'],
    returns: 'PipelineMetrics',
    category: 'metrics'
  },
  {
    name: 'recordPipelineStage',
    file: 'src/metrics/pipeline.ts',
    description: 'Records metrics for a specific pipeline stage',
    parameters: ['stage: string', 'duration: number', 'result: any'],
    returns: 'void',
    category: 'metrics'
  },

  // From src/metrics/json-parse.ts
  {
    name: 'safeJsonParse',
    file: 'src/metrics/json-parse.ts',
    description: 'Safely parses JSON with fallback to string extraction',
    parameters: ['text: string'],
    returns: 'any',
    category: 'parsing'
  },
  {
    name: 'extractJsonFromText',
    file: 'src/metrics/json-parse.ts',
    description: 'Extracts JSON objects from text using regex patterns',
    parameters: ['text: string'],
    returns: 'any[]',
    category: 'parsing'
  },

  // From src/pipeline/context-pack.ts
  {
    name: 'createContextPack',
    file: 'src/pipeline/context-pack.ts',
    description: 'Creates a context pack for agent execution',
    parameters: ['context: ExecutionContext'],
    returns: 'ContextPack',
    category: 'pipeline'
  },
  {
    name: 'mergeContextPacks',
    file: 'src/pipeline/context-pack.ts',
    description: 'Merges multiple context packs into one',
    parameters: ['packs: ContextPack[]'],
    returns: 'ContextPack',
    category: 'pipeline'
  },

  // From src/pipeline/run-state.ts
  {
    name: 'createRunState',
    file: 'src/pipeline/run-state.ts',
    description: 'Creates a new pipeline run state',
    parameters: ['initialState?: Partial<RunState>'],
    returns: 'RunState',
    category: 'pipeline'
  },
  {
    name: 'updateRunState',
    file: 'src/pipeline/run-state.ts',
    description: 'Updates the pipeline run state with new data',
    parameters: ['state: RunState', 'updates: Partial<RunState>'],
    returns: 'RunState',
    category: 'pipeline'
  },
  {
    name: 'getRunStateSnapshot',
    file: 'src/pipeline/run-state.ts',
    description: 'Gets a snapshot of the current run state',
    parameters: ['state: RunState'],
    returns: 'RunStateSnapshot',
    category: 'pipeline'
  },

  // From src/pipeline/agent-memory.ts
  {
    name: 'createAgentMemory',
    file: 'src/pipeline/agent-memory.ts',
    description: 'Creates a new agent memory instance',
    parameters: ['agentId: string', 'options?: MemoryOptions'],
    returns: 'AgentMemory',
    category: 'memory'
  },
  {
    name: 'storeMemory',
    file: 'src/pipeline/agent-memory.ts',
    description: 'Stores a memory entry for an agent',
    parameters: ['memory: AgentMemory', 'key: string', 'value: any'],
    returns: 'void',
    category: 'memory'
  },
  {
    name: 'retrieveMemory',
    file: 'src/pipeline/agent-memory.ts',
    description: 'Retrieves a memory entry for an agent',
    parameters: ['memory: AgentMemory', 'key: string'],
    returns: 'any',
    category: 'memory'
  },

  // From src/pipeline/unified.ts
  {
    name: 'createUnifiedPipeline',
    file: 'src/pipeline/unified.ts',
    description: 'Creates a unified pipeline processor',
    parameters: ['config: PipelineConfig'],
    returns: 'PipelineProcessor',
    category: 'pipeline'
  },
  {
    name: 'executePipeline',
    file: 'src/pipeline/unified.ts',
    description: 'Executes a pipeline with given input',
    parameters: ['processor: PipelineProcessor', 'input: any'],
    returns: 'Promise<PipelineResult>',
    category: 'pipeline'
  },

  // From src/interface/mcp-handler.ts
  {
    name: 'createMCPHandler',
    file: 'src/interface/mcp-handler.ts',
    description: 'Creates a Model Context Protocol handler',
    parameters: ['options: MCPOptions'],
    returns: 'MCPHandler',
    category: 'interface'
  },
  {
    name: 'handleMCPRequest',
    file: 'src/interface/mcp-handler.ts',
    description: 'Handles an incoming MCP request',
    parameters: ['handler: MCPHandler', 'request: MCPRequest'],
    returns: 'Promise<MCPResponse>',
    category: 'interface'
  },

  // From src/interface/server.ts
  {
    name: 'createServer',
    file: 'src/interface/server.ts',
    description: 'Creates an HTTP server instance',
    parameters: ['config: ServerConfig'],
    returns: 'Server',
    category: 'interface'
  },
  {
    name: 'startServer',
    file: 'src/interface/server.ts',
    description: 'Starts the HTTP server',
    parameters: ['server: Server'],
    returns: 'Promise<void>',
    category: 'interface'
  },

  // From src/tools/manager.js
  {
    name: 'createToolManager',
    file: 'src/tools/manager.js',
    description: 'Creates a tool manager instance',
    parameters: ['options: ToolManagerOptions'],
    returns: 'ToolManager',
    category: 'tools'
  },
  {
    name: 'registerTool',
    file: 'src/tools/manager.js',
    description: 'Registers a new tool with the manager',
    parameters: ['manager: ToolManager', 'tool: Tool'],
    returns: 'void',
    category: 'tools'
  },
  {
    name: 'executeTool',
    file: 'src/tools/manager.js',
    description: 'Executes a registered tool',
    parameters: ['manager: ToolManager', 'toolName: string', 'args: any[]'],
    returns: 'Promise<any>',
    category: 'tools'
  },

  // From src/checkpoint/store.ts
  {
    name: 'createCheckpointStore',
    file: 'src/checkpoint/store.ts',
    description: 'Creates a checkpoint store for state persistence',
    parameters: ['options: StoreOptions'],
    returns: 'CheckpointStore',
    category: 'checkpoint'
  },
  {
    name: 'saveCheckpoint',
    file: 'src/checkpoint/store.ts',
    description: 'Saves a checkpoint to the store',
    parameters: ['store: CheckpointStore', 'checkpoint: Checkpoint'],
    returns: 'Promise<void>',
    category: 'checkpoint'
  },
  {
    name: 'loadCheckpoint',
    file: 'src/checkpoint/store.ts',
    description: 'Loads a checkpoint from the store',
    parameters: ['store: CheckpointStore', 'checkpointId: string'],
    returns: 'Promise<Checkpoint>',
    category: 'checkpoint'
  },

  // From src/context/augment.ts
  {
    name: 'augmentContext',
    file: 'src/context/augment.ts',
    description: 'Augments execution context with additional information',
    parameters: ['context: ExecutionContext', 'augmenters: ContextAugmenter[]'],
    returns: 'ExecutionContext',
    category: 'context'
  },
  {
    name: 'createContextAugmenter',
    file: 'src/context/augment.ts',
    description: 'Creates a context augmenter function',
    parameters: ['augmenter: (context: ExecutionContext) => ExecutionContext'],
    returns: 'ContextAugmenter',
    category: 'context'
  },

  // From src/context/git.ts
  {
    name: 'getGitContext',
    file: 'src/context/git.ts',
    description: 'Extracts git-related context information',
    parameters: ['repoPath: string'],
    returns: 'Promise<GitContext>',
    category: 'context'
  },
  {
    name: 'getGitDiff',
    file: 'src/context/git.ts',
    description: 'Gets the git diff for the current changes',
    parameters: ['repoPath: string'],
    returns: 'Promise<string>',
    category: 'context'
  },

  // From src/capabilities/index.ts
  {
    name: 'getAgentCapabilities',
    file: 'src/capabilities/index.ts',
    description: 'Gets all capabilities for a specific agent',
    parameters: ['agentId: string'],
    returns: 'Capability[]',
    category: 'capabilities'
  },
  {
    name: 'registerCapability',
    file: 'src/capabilities/index.ts',
    description: 'Registers a new capability for an agent',
    parameters: ['agentId: string', 'capability: Capability'],
    returns: 'void',
    category: 'capabilities'
  },

  // From src/memory/broker.ts
  {
    name: 'createMemoryBroker',
    file: 'src/memory/broker.ts',
    description: 'Creates a memory broker for unified memory access',
    parameters: ['options: BrokerOptions'],
    returns: 'MemoryBroker',
    category: 'memory'
  },
  {
    name: 'queryMemory',
    file: 'src/memory/broker.ts',
    description: 'Queries memory using the broker',
    parameters: ['broker: MemoryBroker', 'query: string'],
    returns: 'Promise<MemoryResult>',
    category: 'memory'
  },

  // From src/memory/agentkeeper.ts
  {
    name: 'createAgentKeeper',
    file: 'src/memory/agentkeeper.ts',
    description: 'Creates an agent keeper for task result storage',
    parameters: ['options: KeeperOptions'],
    returns: 'AgentKeeper',
    category: 'memory'
  },
  {
    name: 'recordTask',
    file: 'src/memory/agentkeeper.ts',
    description: 'Records a completed task result',
    parameters: ['keeper: AgentKeeper', 'task: TaskRecord'],
    returns: 'Promise<void>',
    category: 'memory'
  },

  // From src/memory/index.ts
  {
    name: 'initializeMemory',
    file: 'src/memory/index.ts',
    description: 'Initializes the memory subsystem',
    parameters: ['config: MemoryConfig'],
    returns: 'Promise<MemorySystem>',
    category: 'memory'
  },
  {
    name: 'getMemoryStats',
    file: 'src/memory/index.ts',
    description: 'Gets statistics about the memory system',
    parameters: ['system: MemorySystem'],
    returns: 'MemoryStats',
    category: 'memory'
  },

  // From src/cache/token-cache.ts
  {
    name: 'createTokenCache',
    file: 'src/cache/token-cache.ts',
    description: 'Creates a token cache for API calls',
    parameters: ['options: CacheOptions'],
    returns: 'TokenCache',
    category: 'cache'
  },
  {
    name: 'getCachedTokens',
    file: 'src/cache/token-cache.ts',
    description: 'Retrieves cached tokens if available',
    parameters: ['cache: TokenCache', 'key: string'],
    returns: 'string | null',
    category: 'cache'
  },

  // From src/autofix/runner.ts
  {
    name: 'createAutofixRunner',
    file: 'src/autofix/runner.ts',
    description: 'Creates an autofix runner instance',
    parameters: ['options: AutofixOptions'],
    returns: 'AutofixRunner',
    category: 'autofix'
  },
  {
    name: 'runAutofix',
    file: 'src/autofix/runner.ts',
    description: 'Runs autofix on a given issue',
    parameters: ['runner: AutofixRunner', 'issue: Issue'],
    returns: 'Promise<AutofixResult>',
    category: 'autofix'
  },

  // From src/autofix/store.ts
  {
    name: 'createAutofixStore',
    file: 'src/autofix/store.ts',
    description: 'Creates an autofix store for saving results',
    parameters: ['options: StoreOptions'],
    returns: 'AutofixStore',
    category: 'autofix'
  },
  {
    name: 'saveAutofix',
    file: 'src/autofix/store.ts',
    description: 'Saves an autofix result to the store',
    parameters: ['store: AutofixStore', 'result: AutofixResult'],
    returns: 'Promise<void>',
    category: 'autofix'
  }
];

/**
 * Search for utility functions by category or name
 */
export function findUtilities(search: string): UtilityFunction[] {
  const lowerSearch = search.toLowerCase();
  return utilityFunctions.filter(func => 
    func.name.toLowerCase().includes(lowerSearch) ||
    func.category.toLowerCase().includes(lowerSearch) ||
    func.description.toLowerCase().includes(lowerSearch)
  );
}

/**
 * Get all unique categories
 */
export function getCategories(): string[] {
  const categories = new Set(utilityFunctions.map(func => func.category));
  return Array.from(categories).sort();
}

/**
 * Get utilities by category
 */
export function getUtilitiesByCategory(category: string): UtilityFunction[] {
  return utilityFunctions.filter(func => func.category === category);
}
