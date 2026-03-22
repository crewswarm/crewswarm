/**
 * Blast Radius Analysis — safe refactoring guard.
 *
 * Uses the repository dependency graph + git diff to compute which files and
 * symbols are affected by a set of changes, and assigns a risk score.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { buildRepositoryGraph, type RepositoryGraph, type RepositoryGraphNode } from '../mapping/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high';

export interface AffectedFile {
  /** Relative path of the affected file */
  path: string;
  /** How it is affected: directly changed, or transitively impacted */
  relation: 'changed' | 'direct-importer' | 'transitive-importer';
  /** Depth from the changed file (0 = changed, 1 = direct importer, …) */
  depth: number;
}

export interface BlastRadiusReport {
  /** Changed files extracted from git diff */
  changedFiles: string[];
  /** All affected files (changed + importers, transitively) */
  affectedFiles: AffectedFile[];
  /** Total unique files impacted */
  impactCount: number;
  /** Risk level */
  risk: RiskLevel;
  /** Human-readable summary */
  summary: string;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function severityRank(level: RiskLevel): number {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

export function isSeverityAtLeast(actual: RiskLevel, threshold: RiskLevel): boolean {
  return severityRank(actual) >= severityRank(threshold);
}

// ---------------------------------------------------------------------------
// Git diff parsing
// ---------------------------------------------------------------------------

async function getChangedFiles(cwd: string, diffRef?: string): Promise<string[]> {
  const args = diffRef
    ? ['diff', '--name-only', diffRef]
    : ['diff', '--name-only', 'HEAD'];

  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    // Fallback: unstaged changes
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only'], { cwd, maxBuffer: 1024 * 1024 });
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Transitive impact traversal
// ---------------------------------------------------------------------------

function collectImporters(
  graph: RepositoryGraph,
  startFiles: Set<string>,
  maxDepth = 5
): AffectedFile[] {
  const nodeByPath = new Map<string, RepositoryGraphNode>();
  for (const node of graph.nodes) {
    nodeByPath.set(node.path, node);
  }

  const visited = new Map<string, AffectedFile>();

  // Seed with changed files
  for (const file of startFiles) {
    visited.set(file, { path: file, relation: 'changed', depth: 0 });
  }

  // BFS through importedBy edges
  let frontier = new Set(startFiles);

  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
    const nextFrontier = new Set<string>();
    for (const file of frontier) {
      const node = nodeByPath.get(file);
      if (!node) continue;
      for (const importer of node.importedBy) {
        if (visited.has(importer)) continue;
        const relation: AffectedFile['relation'] = depth === 1 ? 'direct-importer' : 'transitive-importer';
        visited.set(importer, { path: importer, relation, depth });
        nextFrontier.add(importer);
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(visited.values()).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

function assessRisk(changedCount: number, impactCount: number, totalNodes: number): RiskLevel {
  // For very small repos (<10 files), use absolute counts only
  if (totalNodes < 10) {
    if (impactCount > 8) return 'high';
    if (impactCount > 4) return 'medium';
    return 'low';
  }

  const impactRatio = totalNodes > 0 ? impactCount / totalNodes : 0;

  // High: >30% of codebase affected or >20 files impacted
  if (impactRatio > 0.3 || impactCount > 20) return 'high';
  // Medium: >10% or >8 files
  if (impactRatio > 0.1 || impactCount > 8) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeBlastRadius(
  cwd: string,
  options: { diffRef?: string; maxDepth?: number; changedFiles?: string[] } = {}
): Promise<BlastRadiusReport> {
  const rootDir = resolve(cwd);
  const maxDepth = options.maxDepth ?? 5;

  // 1. Get changed files from git diff or explicit list
  let rawChanged = options.changedFiles ?? await getChangedFiles(rootDir, options.diffRef);

  // 2. Build repository dependency graph
  const graph = await buildRepositoryGraph(rootDir);

  // Normalize changed file paths to match graph paths (relative)
  const graphPaths = new Set(graph.nodes.map(n => n.path));
  const changedSet = new Set<string>();
  for (const file of rawChanged) {
    const rel = relative(rootDir, resolve(rootDir, file));
    if (graphPaths.has(rel)) changedSet.add(rel);
  }

  // 3. Traverse import graph for transitive impact
  const affectedFiles = collectImporters(graph, changedSet, maxDepth);
  const impactCount = affectedFiles.length;

  // 4. Assess risk
  const risk = assessRisk(changedSet.size, impactCount, graph.nodeCount);

  // 5. Build summary
  const changedList = Array.from(changedSet);
  const directImporters = affectedFiles.filter(f => f.relation === 'direct-importer').length;
  const transitiveImporters = affectedFiles.filter(f => f.relation === 'transitive-importer').length;

  const riskEmoji = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }[risk];
  const lines = [
    `Blast Radius: ${riskEmoji}`,
    `  Changed files: ${changedSet.size}`,
    `  Direct importers: ${directImporters}`,
    `  Transitive importers: ${transitiveImporters}`,
    `  Total impacted: ${impactCount} / ${graph.nodeCount} source files`
  ];

  if (risk === 'high') {
    lines.push('', '  ⚠ HIGH RISK — review affected files carefully before applying.');
  }

  return {
    changedFiles: changedList,
    affectedFiles,
    impactCount,
    risk,
    summary: lines.join('\n')
  };
}
