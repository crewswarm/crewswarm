import type { BlastRadiusReport } from '../blast-radius/index.js';

export interface PatchRiskAssessment {
  riskScore: number; // 0..100
  confidenceScore: number;
  // Backward-compatible aliases used by CLI output paths.
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export function scorePatchRisk(input: {
  blastRadius?: Partial<BlastRadiusReport> | null;
  validationPassed?: boolean;
  changedFiles?: number;
  failedSteps?: number;
  risk?: 'low' | 'medium' | 'high';
  summary?: string;
  changedFilesList?: string[];
}): PatchRiskAssessment {
  const reasons: string[] = [];
  let risk = 0.2;

  const changedFiles = Number(input.changedFiles || input.changedFilesList?.length || 0);
  if (changedFiles >= 12) {
    risk += 0.25;
    reasons.push('large-change-set');
  } else if (changedFiles >= 5) {
    risk += 0.15;
    reasons.push('medium-change-set');
  }

  const blast = input.blastRadius || input;
  const blastRisk = String((blast as any)?.risk || '').toLowerCase();
  if (blastRisk === 'high') {
    risk += 0.35;
    reasons.push('high-blast-radius');
  } else if (blastRisk === 'medium') {
    risk += 0.2;
    reasons.push('medium-blast-radius');
  }

  if (Number(input.failedSteps || 0) > 0) {
    risk += 0.2;
    reasons.push('failed-plan-steps');
  }

  if (input.validationPassed === false) {
    risk += 0.25;
    reasons.push('validation-failed');
  } else if (input.validationPassed === true) {
    risk -= 0.1;
    reasons.push('validation-passed');
  } else {
    reasons.push('validation-unknown');
  }

  const boundedRisk = Math.max(0, Math.min(1, risk));
  const confidenceScore = Math.max(0, Math.min(1, 1 - boundedRisk));
  const level: 'low' | 'medium' | 'high' = boundedRisk >= 0.75
    ? 'high'
    : boundedRisk >= 0.45
      ? 'medium'
      : 'low';

  const riskScore = Number((boundedRisk * 100).toFixed(1));
  return {
    riskScore,
    confidenceScore: Number(confidenceScore.toFixed(3)),
    confidence: Number(confidenceScore.toFixed(3)),
    riskLevel: level,
    level,
    reasons
  };
}
