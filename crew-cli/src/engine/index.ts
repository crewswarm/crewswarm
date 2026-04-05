/**
 * Engine — Central execution ownership for crew-cli.
 *
 * RunState: owns phase lifecycle, failure memory, verification goals, cost tracking
 * RunEngine: wraps autonomous execution with RunState integration
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
