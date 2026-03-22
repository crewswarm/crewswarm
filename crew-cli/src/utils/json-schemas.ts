export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

export function validateRouterDecision(v: any): ValidationResult {
  const errors: string[] = [];
  if (!isObject(v)) return result(['must be object']);
  const decision = String(v.decision || '').trim();
  // Normalize: lowercase, replace underscores with hyphens, strip whitespace
  const lower = decision.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  // Accept any string that normalizeDecision() in unified.ts would handle,
  // plus common LLM variations (underscores, extra words, etc.)
  const looksLikeDecision =
    lower.length > 0 &&
    (
      lower.includes('direct') ||
      lower.includes('answer') ||
      lower.includes('chat') ||
      lower.includes('local') ||
      lower.includes('code') ||
      lower.includes('parallel') ||
      lower.includes('dispatch') ||
      lower.includes('simple') ||
      lower.includes('execute') ||
      lower.includes('run') ||
      lower.includes('plan') ||
      lower.includes('build') ||
      lower.includes('implement')
    );
  if (!looksLikeDecision) {
    errors.push('invalid decision');
  }
  if (!String(v.reasoning || '').trim()) errors.push('missing reasoning');
  return result(errors);
}

export function validateWorkGraph(v: any): ValidationResult {
  const errors: string[] = [];
  if (!isObject(v)) return result(['must be object']);
  if (!Array.isArray(v.units)) errors.push('units must be array');
  if (!Array.isArray(v.requiredPersonas)) errors.push('requiredPersonas must be array');
  if (typeof v.totalComplexity !== 'number') errors.push('totalComplexity must be number');
  if (typeof v.estimatedCost !== 'number') errors.push('estimatedCost must be number');
  for (const unit of Array.isArray(v.units) ? v.units : []) {
    if (!isObject(unit)) { errors.push('unit must be object'); continue; }
    if (!String(unit.id || '').trim()) errors.push('unit.id missing');
    if (!String(unit.description || '').trim()) errors.push('unit.description missing');
    if (!String(unit.requiredPersona || '').trim()) errors.push('unit.requiredPersona missing');
    if (!Array.isArray(unit.dependencies)) errors.push('unit.dependencies must be array');
    if (!Array.isArray(unit.requiredCapabilities)) errors.push('unit.requiredCapabilities must be array');
    if (!Array.isArray(unit.sourceRefs) || unit.sourceRefs.length === 0) errors.push(`unit.sourceRefs missing for ${String(unit.id || 'unknown')}`);
    if (!Array.isArray(unit.allowedPaths)) errors.push(`unit.allowedPaths must be array for ${String(unit.id || 'unknown')}`);
    if (!Array.isArray(unit.verification) || unit.verification.length === 0) errors.push(`unit.verification missing for ${String(unit.id || 'unknown')}`);
    if (!Array.isArray(unit.escalationHints) || unit.escalationHints.length === 0) errors.push(`unit.escalationHints missing for ${String(unit.id || 'unknown')}`);
    if (typeof unit.maxFilesTouched !== 'number' || !Number.isFinite(unit.maxFilesTouched) || unit.maxFilesTouched < 1) {
      errors.push(`unit.maxFilesTouched invalid for ${String(unit.id || 'unknown')}`);
    }
  }
  return result(errors);
}

export function validatePolicyValidation(v: any): ValidationResult {
  const errors: string[] = [];
  if (!isObject(v)) return result(['must be object']);
  if (typeof v.approved !== 'boolean') errors.push('approved must be boolean');
  if (!['low', 'medium', 'high', 'critical'].includes(String(v.riskLevel || ''))) errors.push('invalid riskLevel');
  if (!Array.isArray(v.concerns)) errors.push('concerns must be array');
  if (!Array.isArray(v.recommendations)) errors.push('recommendations must be array');
  if (typeof v.estimatedCost !== 'number') errors.push('estimatedCost must be number');
  return result(errors);
}
