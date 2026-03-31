/**
 * Pipeline Run State — strict ordered stage machine.
 *
 * Bootstrap graph stages:
 *   scan → route → plan → validate-plan → execute → evidence → qa → checkpoint → complete
 *
 * Each stage MUST complete before the next starts.
 * 'failed' can be entered from any stage.
 * Stages can be skipped (e.g., direct-answer skips execute..checkpoint).
 */

export type PipelinePhase =
  | 'init'
  | 'scan'             // Build ProjectContext
  | 'route'            // L1 classify
  | 'plan'             // L2 decompose
  | 'validate-plan'    // Check work units are well-formed
  | 'execute'          // L3 workers
  | 'evidence'         // Build transcript + file diffs
  | 'validate'         // Deterministic QA + optional LLM review (legacy compat alias for 'qa')
  | 'qa'               // Deterministic QA + optional LLM review
  | 'checkpoint'       // Git commit if changes made
  | 'complete'
  | 'failed';

const ORDER: PipelinePhase[] = [
  'init', 'scan', 'route', 'plan', 'validate-plan',
  'execute', 'evidence', 'validate', 'qa', 'checkpoint', 'complete'
];

export class PipelineRunState {
  private phase: PipelinePhase = 'init';
  private timeline: Array<{ phase: PipelinePhase; ts: string; durationMs?: number; note?: string }> = [
    { phase: 'init', ts: new Date().toISOString() }
  ];
  private phaseStartTime: number = Date.now();

  transition(next: PipelinePhase, note?: string) {
    const now = Date.now();
    const durationMs = now - this.phaseStartTime;

    // Update the current phase's duration
    if (this.timeline.length > 0) {
      this.timeline[this.timeline.length - 1].durationMs = durationMs;
    }

    if (next === 'failed') {
      this.phase = 'failed';
      this.timeline.push({ phase: 'failed', ts: new Date().toISOString(), note });
      return;
    }

    // Allow 'validate' as legacy alias for 'qa'
    const effectiveNext = next === 'validate' ? next : next;

    const currentIdx = ORDER.indexOf(this.phase);
    const nextIdx = ORDER.indexOf(effectiveNext);
    if (currentIdx < 0 || nextIdx < 0 || nextIdx <= currentIdx) {
      // Allow skipping forward (not just adjacent) — but never backward
      if (nextIdx <= currentIdx) {
        throw new Error(`Invalid phase transition: ${this.phase} -> ${next} (cannot go backward)`);
      }
    }

    this.phase = effectiveNext;
    this.phaseStartTime = now;
    this.timeline.push({ phase: effectiveNext, ts: new Date().toISOString(), note });
  }

  current() {
    return this.phase;
  }

  getTimeline() {
    return [...this.timeline];
  }

  /** Total elapsed time from init to current phase. */
  totalElapsedMs(): number {
    if (this.timeline.length < 2) return 0;
    const first = new Date(this.timeline[0].ts).getTime();
    return Date.now() - first;
  }

  /** Get timing for a specific phase. */
  phaseDuration(phase: PipelinePhase): number | undefined {
    const entry = this.timeline.find(e => e.phase === phase);
    return entry?.durationMs;
  }
}

