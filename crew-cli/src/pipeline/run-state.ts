export type PipelinePhase =
  | 'init'
  | 'plan'
  | 'execute'
  | 'validate'
  | 'complete'
  | 'failed';

const ORDER: PipelinePhase[] = ['init', 'plan', 'execute', 'validate', 'complete'];

export class PipelineRunState {
  private phase: PipelinePhase = 'init';
  private timeline: Array<{ phase: PipelinePhase; ts: string; note?: string }> = [
    { phase: 'init', ts: new Date().toISOString() }
  ];

  transition(next: PipelinePhase, note?: string) {
    if (next === 'failed') {
      this.phase = 'failed';
      this.timeline.push({ phase: 'failed', ts: new Date().toISOString(), note });
      return;
    }
    const currentIdx = ORDER.indexOf(this.phase);
    const nextIdx = ORDER.indexOf(next);
    if (currentIdx < 0 || nextIdx < 0 || nextIdx < currentIdx || nextIdx - currentIdx > 1) {
      throw new Error(`Invalid phase transition: ${this.phase} -> ${next}`);
    }
    this.phase = next;
    this.timeline.push({ phase: next, ts: new Date().toISOString(), note });
  }

  current() {
    return this.phase;
  }

  getTimeline() {
    return [...this.timeline];
  }
}

