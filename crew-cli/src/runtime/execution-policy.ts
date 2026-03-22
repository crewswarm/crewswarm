import { runDoctorChecks, summarizeDoctorResults } from '../diagnostics/doctor.js';
import { resolveCapabilityMap } from '../capabilities/index.js';

export type RiskThreshold = 'low' | 'medium' | 'high';

export interface ExecutionPolicy {
  strictPreflight: boolean;
  retryAttempts: number;
  retryBackoffMs: number;
  riskThreshold: RiskThreshold;
  forceAutoApply: boolean;
  diffFirst: boolean;
}

export function getExecutionPolicy(input: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  const retryAttempts = Number(input.retryAttempts ?? process.env.CREW_RETRY_ATTEMPTS ?? 2);
  const retryBackoffMs = Number(input.retryBackoffMs ?? process.env.CREW_RETRY_BACKOFF_MS ?? 600);
  const rawThreshold = String(input.riskThreshold ?? process.env.CREW_RISK_THRESHOLD ?? 'high').toLowerCase();
  const riskThreshold: RiskThreshold =
    rawThreshold === 'low' || rawThreshold === 'medium' || rawThreshold === 'high'
      ? rawThreshold
      : 'high';
  const strictPreflight =
    Boolean(input.strictPreflight) ||
    String(process.env.CREW_STRICT_PREFLIGHT || '').toLowerCase() === 'true';
  const forceAutoApply =
    Boolean(input.forceAutoApply) ||
    String(process.env.CREW_FORCE_AUTO_APPLY || '').toLowerCase() === 'true';
  const diffFirst = String(process.env.CREW_DIFF_FIRST || 'true').toLowerCase() !== 'false';

  return {
    strictPreflight,
    retryAttempts: Number.isFinite(retryAttempts) ? Math.max(1, Math.min(5, Math.floor(retryAttempts))) : 2,
    retryBackoffMs: Number.isFinite(retryBackoffMs) ? Math.max(100, Math.min(5000, Math.floor(retryBackoffMs))) : 600,
    riskThreshold,
    forceAutoApply,
    diffFirst
  };
}

export function isRetryableError(error: unknown): boolean {
  const text = String((error as Error)?.message || '').toLowerCase();
  return (
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('timeout') ||
    text.includes('temporar') ||
    text.includes('unavailable') ||
    text.includes('quota') ||
    text.includes('connection reset') ||
    text.includes('econnreset')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  policy: ExecutionPolicy,
  opts: { label?: string; shouldRetry?: (error: unknown) => boolean } = {}
): Promise<T> {
  const attempts = Math.max(1, policy.retryAttempts);
  let lastError: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      const retryable = (opts.shouldRetry || isRetryableError)(error);
      const hasNext = i < attempts;
      if (!retryable || !hasNext) break;
      const delay = Math.round(policy.retryBackoffMs * i + Math.random() * 120);
      await sleep(delay);
    }
  }
  throw lastError;
}

export async function enforceStrictPreflight(policy: ExecutionPolicy, gateway?: string): Promise<void> {
  if (!policy.strictPreflight) return;
  const checks = await runDoctorChecks({ gateway: gateway || 'http://localhost:5010' });
  const summary = summarizeDoctorResults(checks);
  if (summary.failed > 0) {
    const failed = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.details}`).join('; ');
    throw new Error(`Strict preflight failed (${summary.failed} checks): ${failed}`);
  }
}

export function getCapabilityHandshake(mode: 'standalone' | 'connected') {
  const caps = resolveCapabilityMap(mode);
  return {
    mode: caps.mode,
    can_read: caps.canRead,
    can_write: caps.canWrite,
    can_pty: caps.canPty,
    can_lsp: caps.canLsp,
    can_dispatch: caps.canDispatch,
    can_git: caps.canGit
  };
}

export function isRiskBlocked(
  risk: 'low' | 'medium' | 'high',
  threshold: RiskThreshold,
  force = false
): boolean {
  if (force) return false;
  const score = { low: 1, medium: 2, high: 3 };
  return score[risk] >= score[threshold];
}
