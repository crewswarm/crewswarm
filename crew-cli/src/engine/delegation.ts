/**
 * Delegation Tuning — Choose the right persona/model for each task.
 *
 * When the pipeline decomposes work into units, delegation tuning selects
 * the optimal persona and model based on:
 *   - Task characteristics (file types, complexity, scope)
 *   - Historical performance (which persona/model succeeded on similar tasks)
 *   - Cost/speed tradeoffs (use cheap models for simple tasks)
 *   - Failure avoidance (don't assign a persona that recently failed similar work)
 *
 * This is deterministic scoring — no LLM call. It augments the L2 planner's
 * persona assignments with empirical tuning data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationCandidate {
  persona: string;
  model: string;
  score: number;
  reasons: string[];
}

export interface TaskCharacteristics {
  /** Primary language/framework (e.g., 'typescript', 'react', 'python') */
  language?: string;
  /** File paths involved */
  files: string[];
  /** Task description */
  description: string;
  /** Estimated complexity */
  complexity: 'low' | 'medium' | 'high';
  /** Required capabilities */
  capabilities: string[];
  /** Task type derived from description */
  taskType: TaskType;
}

export type TaskType =
  | 'create-file'       // New file from scratch
  | 'edit-existing'     // Modify existing code
  | 'fix-bug'           // Debug and fix
  | 'add-test'          // Write tests
  | 'refactor'          // Restructure without behavior change
  | 'review'            // Code review / QA
  | 'docs'              // Documentation
  | 'config'            // Configuration / build setup
  | 'research'          // Read and understand code
  | 'mixed';            // Multiple types

export interface PerformanceRecord {
  persona: string;
  model: string;
  taskType: TaskType;
  success: boolean;
  turns: number;
  costUsd: number;
  verificationPassed: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Persona registry — what each persona is good at
// ---------------------------------------------------------------------------

interface PersonaProfile {
  id: string;
  strengths: TaskType[];
  languages: string[];
  /** Cost tier: cheaper personas for simpler tasks */
  costTier: 'fast' | 'standard' | 'heavy';
  /** Max complexity this persona should handle */
  maxComplexity: 'low' | 'medium' | 'high';
}

const PERSONA_PROFILES: PersonaProfile[] = [
  {
    id: 'executor-code',
    strengths: ['create-file', 'edit-existing', 'fix-bug', 'refactor', 'mixed'],
    languages: ['typescript', 'javascript', 'python', 'go', 'rust'],
    costTier: 'standard',
    maxComplexity: 'high'
  },
  {
    id: 'crew-coder',
    strengths: ['create-file', 'edit-existing', 'mixed'],
    languages: ['typescript', 'javascript', 'python', 'go', 'rust', 'java'],
    costTier: 'standard',
    maxComplexity: 'high'
  },
  {
    id: 'crew-coder-back',
    strengths: ['create-file', 'edit-existing', 'fix-bug', 'config'],
    languages: ['typescript', 'javascript', 'python', 'go', 'rust', 'sql'],
    costTier: 'standard',
    maxComplexity: 'high'
  },
  {
    id: 'crew-coder-front',
    strengths: ['create-file', 'edit-existing', 'refactor'],
    languages: ['typescript', 'javascript', 'css', 'html', 'react', 'vue'],
    costTier: 'standard',
    maxComplexity: 'medium'
  },
  {
    id: 'crew-qa',
    strengths: ['add-test', 'review'],
    languages: ['typescript', 'javascript', 'python'],
    costTier: 'fast',
    maxComplexity: 'medium'
  },
  {
    id: 'crew-fixer',
    strengths: ['fix-bug', 'edit-existing'],
    languages: ['typescript', 'javascript', 'python', 'go'],
    costTier: 'standard',
    maxComplexity: 'high'
  },
  {
    id: 'crew-copywriter',
    strengths: ['docs'],
    languages: ['markdown'],
    costTier: 'fast',
    maxComplexity: 'low'
  },
  {
    id: 'crew-security',
    strengths: ['review', 'fix-bug'],
    languages: ['typescript', 'javascript', 'python', 'go'],
    costTier: 'standard',
    maxComplexity: 'high'
  }
];

// ---------------------------------------------------------------------------
// Task analysis
// ---------------------------------------------------------------------------

export function analyzeTask(description: string, files: string[], capabilities: string[] = []): TaskCharacteristics {
  const lower = description.toLowerCase();
  const taskType = detectTaskType(lower);
  const language = detectLanguage(files);
  const complexity = estimateComplexity(lower, files);

  return {
    language,
    files,
    description,
    complexity,
    capabilities,
    taskType
  };
}

function detectTaskType(desc: string): TaskType {
  // Order matters: domain-specific patterns before generic action words.
  // "write documentation" should be docs, not edit-existing.
  // "add tests" should be add-test, not edit-existing.
  if (/\btest|spec|assert|coverage|jest|mocha|vitest\b/.test(desc)) return 'add-test';
  if (/\b(fix|bug|broken|crash|error|fail|debug)\b/.test(desc)) return 'fix-bug';
  if (/\b(refactor|restructure|reorganize|clean.?up|simplif)\b/.test(desc)) return 'refactor';
  if (/\b(review|audit|check|inspect|securit)\b/.test(desc)) return 'review';
  if (/\b(docs?|document(ation)?|readme|guide|tutorial)\b/.test(desc)) return 'docs';
  if (/\b(config|setup|install|deploy|docker|ci|cd)\b/.test(desc)) return 'config';
  if (/\b(read|understand|explore|investigate|research|analyz)\b/.test(desc)) return 'research';
  if (/\b(create|add|new|implement|build|write)\b/.test(desc)) {
    if (/\b(new file|new component|from scratch|create)\b/.test(desc)) return 'create-file';
    return 'edit-existing';
  }
  return 'mixed';
}

function detectLanguage(files: string[]): string | undefined {
  const extensions = files
    .map(f => f.split('.').pop()?.toLowerCase())
    .filter(Boolean) as string[];

  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    css: 'css',
    html: 'html',
    md: 'markdown',
    sql: 'sql'
  };

  const counts = new Map<string, number>();
  for (const ext of extensions) {
    const lang = extMap[ext] || ext;
    counts.set(lang, (counts.get(lang) || 0) + 1);
  }

  if (counts.size === 0) return undefined;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function estimateComplexity(desc: string, files: string[]): 'low' | 'medium' | 'high' {
  let score = 0;
  if (files.length > 5) score += 2;
  else if (files.length > 2) score += 1;

  if (desc.length > 500) score += 1;
  if (/\b(architect|system|migration|overhaul|redesign)\b/.test(desc)) score += 2;
  if (/\b(simple|small|minor|quick|trivial)\b/.test(desc)) score -= 1;
  if (/\b(complex|large|major|significant)\b/.test(desc)) score += 1;

  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Delegation scoring
// ---------------------------------------------------------------------------

export class DelegationTuner {
  private performanceHistory: PerformanceRecord[] = [];

  /**
   * Record a completed task's performance for future delegation decisions.
   */
  recordPerformance(record: PerformanceRecord): void {
    this.performanceHistory.push(record);
    // Keep last 200 records
    if (this.performanceHistory.length > 200) {
      this.performanceHistory = this.performanceHistory.slice(-200);
    }
  }

  /**
   * Rank personas for a given task, returning scored candidates.
   */
  rankCandidates(task: TaskCharacteristics): DelegationCandidate[] {
    const candidates: DelegationCandidate[] = [];

    for (const profile of PERSONA_PROFILES) {
      const { score, reasons } = this.scorePersona(profile, task);
      if (score > 0) {
        candidates.push({
          persona: profile.id,
          model: this.recommendModel(profile, task),
          score,
          reasons
        });
      }
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * Get the best persona for a task.
   */
  bestCandidate(task: TaskCharacteristics): DelegationCandidate | null {
    const ranked = this.rankCandidates(task);
    return ranked[0] || null;
  }

  private scorePersona(profile: PersonaProfile, task: TaskCharacteristics): { score: number; reasons: string[] } {
    let score = 50; // baseline
    const reasons: string[] = [];

    // Strength match
    if (profile.strengths.includes(task.taskType)) {
      score += 30;
      reasons.push(`strong at ${task.taskType}`);
    } else {
      score -= 10;
    }

    // Language match
    if (task.language && profile.languages.includes(task.language)) {
      score += 15;
      reasons.push(`knows ${task.language}`);
    } else if (task.language) {
      score -= 5;
    }

    // Complexity match
    const complexityOrder = { low: 0, medium: 1, high: 2 };
    if (complexityOrder[task.complexity] > complexityOrder[profile.maxComplexity]) {
      score -= 20;
      reasons.push('task may be too complex for this persona');
    }

    // Cost efficiency
    if (task.complexity === 'low' && profile.costTier === 'fast') {
      score += 10;
      reasons.push('cost-efficient for simple task');
    }
    if (task.complexity === 'high' && profile.costTier === 'heavy') {
      score += 5;
      reasons.push('heavy-tier appropriate for complex task');
    }

    // Historical performance
    const history = this.performanceHistory.filter(
      r => r.persona === profile.id && r.taskType === task.taskType
    );
    if (history.length >= 3) {
      const successRate = history.filter(r => r.success).length / history.length;
      if (successRate >= 0.8) {
        score += 15;
        reasons.push(`${Math.round(successRate * 100)}% success rate on similar tasks`);
      } else if (successRate < 0.5) {
        score -= 15;
        reasons.push(`low success rate (${Math.round(successRate * 100)}%) on similar tasks`);
      }

      const avgTurns = history.reduce((s, r) => s + r.turns, 0) / history.length;
      if (avgTurns < 10) {
        score += 5;
        reasons.push('historically efficient (few turns)');
      }
    }

    // Recent failures on same persona — avoid
    const recentFailures = history
      .filter(r => !r.success && Date.now() - r.timestamp < 3600_000)
      .length;
    if (recentFailures >= 2) {
      score -= 20;
      reasons.push('recent repeated failures — try different persona');
    }

    return { score: Math.max(0, score), reasons };
  }

  private recommendModel(profile: PersonaProfile, task: TaskCharacteristics): string {
    // Map cost tier + complexity to model recommendation
    if (task.complexity === 'high' || profile.costTier === 'heavy') {
      return 'heavy'; // caller maps to actual model ID
    }
    if (task.complexity === 'low' && profile.costTier === 'fast') {
      return 'fast';
    }
    return 'standard';
  }

  /**
   * Export performance data for persistence.
   */
  exportHistory(): PerformanceRecord[] {
    return [...this.performanceHistory];
  }

  /**
   * Import performance data from persistence.
   */
  importHistory(records: PerformanceRecord[]): void {
    this.performanceHistory = [...records];
  }
}
