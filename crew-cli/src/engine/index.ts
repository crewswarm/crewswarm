/**
 * Engine — Central execution ownership for crew-cli.
 *
 * RunState: phase lifecycle, failure memory, verification goals, cost tracking
 * RunEngine: wraps autonomous execution with RunState integration
 * StructuredHistory: rich turn-by-turn state preservation across layers
 * PatchCritic: per-turn code change quality evaluation
 * DelegationTuner: persona/model selection based on task + history
 * ToolFilter: auto-filter tools based on task domains
 * TopOfMind: persistent instructions injected into every turn
 * ChatRecall: semantic search across conversation history
 * Summon: runtime sub-agent delegation with persona switching
 */

export { RunState } from './run-state.js';
export type {
  RunPhase,
  PhaseRecord,
  FailureRecord,
  FailureCategory,
  VerificationGoal,
  CostBreakdown,
  RunStateSnapshot
} from './run-state.js';

export { RunEngine } from './run-engine.js';
export type {
  RunEngineConfig,
  RunEngineResult
} from './run-engine.js';

export { StructuredHistory } from './structured-history.js';
export type {
  LLMTurnRecord,
  ToolExecutionRecord,
  CompactionRecord,
  ReviewRecord,
  HistoryRecord,
  FileState
} from './structured-history.js';

export { PatchCritic } from './patch-critic.js';
export type {
  CriticFinding,
  CriticSeverity,
  CriticCategory,
  CriticReport,
  PatchCriticConfig
} from './patch-critic.js';

export { DelegationTuner, analyzeTask } from './delegation.js';
export type {
  DelegationCandidate,
  TaskCharacteristics,
  TaskType,
  PerformanceRecord
} from './delegation.js';

export { filterToolsForTask, detectTaskDomains, describeFiltering } from './tool-filter.js';
export type { TaskDomain } from './tool-filter.js';

export { loadTopOfMind, clearTopOfMindCache } from './top-of-mind.js';

export { recallSearch, buildRecallContext } from './chat-recall.js';
export type { RecallEntry, RecallResult } from './chat-recall.js';

export { getPersona, listPersonas, buildSummonPrompt, filterToolsForPersona } from './summon.js';
export type { PersonaConfig, SummonOptions, SummonResult } from './summon.js';
