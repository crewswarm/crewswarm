/**
 * Engine — Central execution ownership for crew-cli.
 *
 * RunState: phase lifecycle, failure memory, verification goals, cost tracking
 * RunEngine: wraps autonomous execution with RunState integration
 * StructuredHistory: rich turn-by-turn state preservation across layers
 * PatchCritic: per-turn code change quality evaluation
 * DelegationTuner: persona/model selection based on task + history
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
