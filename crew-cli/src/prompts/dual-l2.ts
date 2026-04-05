/**
 * Dual-Tier Level 2 Planning System
 * L2A: Decomposer - breaks complex tasks into work graphs
 * L2B: Policy Validator - validates plans for risk/cost/compliance
 */

import { PromptComposer, PromptOverlay } from './registry.js';
import { LocalExecutor } from '../executor/local.js';
import { runAgenticWorker } from '../executor/agentic-executor.js';
import { Sandbox } from '../sandbox/index.js';
import { Logger } from '../utils/logger.js';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseJsonObjectWithRepair } from '../utils/structured-json.js';

export interface WorkUnit {
  id: string;
  description: string;
  requiredPersona: string;
  dependencies: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  requiredCapabilities: string[];
  sourceRefs?: string[];
  allowedPaths?: string[];
  verification?: string[];
  escalationHints?: string[];
  maxFilesTouched?: number;
}

export interface PlanningArtifacts {
  pdd: string;
  roadmap: string;
  architecture: string;
  scaffold: string;
  contractTests: string;
  definitionOfDone: string;
  goldenBenchmarks: string;
  acceptanceCriteria: string[];
  outputDir: string;
  files: {
    pdd: string;
    roadmap: string;
    architecture: string;
    scaffold: string;
    contractTests: string;
    definitionOfDone: string;
    goldenBenchmarks: string;
  };
}

export interface WorkGraph {
  units: WorkUnit[];
  totalComplexity: number;
  requiredPersonas: string[];
  estimatedCost: number;
  summary?: string;
  acceptanceCriteria?: string[];
  planningArtifacts?: PlanningArtifacts;
  planMode?: 'lightweight' | 'full';
}

export interface PolicyValidation {
  approved: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  concerns: string[];
  recommendations: string[];
  fallbackStrategy?: string;
  estimatedCost: number;
}

export interface DualL2Result {
  workGraph: WorkGraph;
  validation: PolicyValidation;
  traceId: string;
  executionPath: string[];
  artifacts?: PlanningArtifacts;
}

export class DualL2Planner {
  private logger = new Logger();
  private composer = new PromptComposer();
  private executor = new LocalExecutor();

  private getReasoningModel(): string | undefined {
    const model = String(process.env.CREW_REASONING_MODEL || '').trim();
    return model || undefined;
  }
  
  private getChatModel(): string | undefined {
    // For structured JSON outputs, use fast chat models, not reasoning models
    const chatModel = String(process.env.CREW_CHAT_MODEL || '').trim();
    const reasoningModel = String(process.env.CREW_REASONING_MODEL || '').trim();
    
    // Avoid reasoning-only models for structured JSON
    // deepseek-reasoner, gemini-*-preview, etc.
    if (reasoningModel && 
        !reasoningModel.includes('deepseek-reasoner') && 
        !reasoningModel.includes('-preview')) {
      return reasoningModel;
    }
    
    return chatModel || undefined;
  }

  private getL2AModel(): string | undefined {
    const model = String(process.env.CREW_L2A_MODEL || '').trim();
    if (model) return model;
    return this.getChatModel();
  }

  private getL2BModel(): string | undefined {
    const model = String(process.env.CREW_L2B_MODEL || '').trim();
    if (model) return model;
    return this.getChatModel();
  }

  private extractAllowedPaths(task: string): string[] {
    const found = new Set<string>();
    const fileNamed = [...task.matchAll(/file named\s+["'`]?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)["'`]?/gi)];
    for (const match of fileNamed) {
      const path = String(match[1] || '').trim();
      if (path) found.add(path);
    }

    const pathLike = [...task.matchAll(/(?:^|[\s("'`])([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?=$|[\s)"'`,.:;])/g)];
    for (const match of pathLike) {
      const path = String(match[1] || '').trim();
      if (path && !path.startsWith('ac-')) found.add(path);
    }

    return Array.from(found).slice(0, 3);
  }

  private isLightweightTask(task: string, context: string = ''): boolean {
    const text = `${task}\n${context}`.toLowerCase();
    if (text.length > 1200) return false;

    const broadSignals = [
      'roadmap',
      'architecture',
      'planning',
      'phase 1',
      'phase 2',
      'phase 3',
      'entire project',
      'whole project',
      'multi-agent',
      'benchmark suite',
      'golden benchmark',
      'definition of done',
      'contract tests',
      'scaffold',
      'deploy',
      'migration',
      'refactor the entire',
      'across the repo'
    ];
    if (broadSignals.some(signal => text.includes(signal))) return false;

    // Multi-part tasks with numbered items or multiple deliverables need full planning
    const numberedItems = text.match(/\d+\)/g) || text.match(/\d+\.\s/g) || [];
    if (numberedItems.length >= 3) return false;

    // Tasks mentioning tests + implementation + docs need decomposition
    const hasTests = /\b(test|spec|assert)\b/.test(text);
    const hasImpl = /\b(endpoint|api|function|class|module|component)\b/.test(text);
    const hasDocs = /\b(readme|doc|documentation)\b/.test(text);
    if ([hasTests, hasImpl, hasDocs].filter(Boolean).length >= 2) return false;

    const paths = this.extractAllowedPaths(task);
    const narrowIntent = /(create|write|update|modify|edit|add|fix|rename)\b/.test(text);
    return narrowIntent && paths.length > 0 && paths.length <= 3;
  }

  private buildLightweightPlan(task: string, context: string, traceId: string): DualL2Result {
    const allowedPaths = this.extractAllowedPaths(task);
    const artifacts: PlanningArtifacts = {
      pdd: `# PDD\n\n## Overview\n- Execute a small scoped implementation task.\n\n## Requirements\n- ${task}`,
      roadmap: `# ROADMAP\n\n## Phase 1\n- Complete the requested small file-scoped task.`,
      architecture: `# ARCH\n\n## Scope\n- Lightweight single-step implementation.\n- Limit edits to explicit task paths.`,
      scaffold: '',
      contractTests: '',
      definitionOfDone: '',
      goldenBenchmarks: '',
      acceptanceCriteria: [
        `Complete task exactly as requested: ${task}`
      ],
      outputDir: '',
      files: {
        pdd: '',
        roadmap: '',
        architecture: '',
        scaffold: '',
        contractTests: '',
        definitionOfDone: '',
        goldenBenchmarks: ''
      }
    };

    const workGraph: WorkGraph = {
      units: [
        {
          id: 'lightweight-execute',
          description: task,
          requiredPersona: 'executor-code',
          dependencies: [],
          estimatedComplexity: allowedPaths.length > 1 ? 'medium' : 'low',
          requiredCapabilities: ['code-generation', 'file-write', 'code-reading'],
          sourceRefs: ['PDD.md#overview', 'ROADMAP.md#phase-1', 'ARCH.md#scope'],
          allowedPaths,
          verification: allowedPaths.map(path => `Confirm ${path} exists and matches the requested content/behavior.`),
          escalationHints: [
            'Escalate if completing the task requires editing files outside the allowed paths.',
            'Escalate after two failed verification attempts.'
          ],
          maxFilesTouched: Math.max(1, allowedPaths.length)
        }
      ],
      totalComplexity: allowedPaths.length > 1 ? 3 : 1,
      requiredPersonas: ['executor-code'],
      estimatedCost: 0.001,
      planningArtifacts: artifacts,
      planMode: 'lightweight'
    };

    return {
      workGraph,
      validation: {
        approved: true,
        riskLevel: 'low',
        concerns: [],
        recommendations: ['Keep edits within explicit allowedPaths.'],
        fallbackStrategy: 'Escalate to full planner if the task expands beyond the scoped files.',
        estimatedCost: 0.001
      },
      traceId,
      executionPath: ['dual-l2-planner', 'l2a-lightweight', 'l2b-lightweight'],
      artifacts
    };
  }

  private async parseStructuredJson<T>(raw: string, label: string, schemaHint?: string): Promise<T> {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }
    
    // Log parse attempt
    console.log(`[JSON Parse] ${label}: raw=${raw.length} chars, cleaned=${cleaned.length} chars`);
    
    const parsed = await parseJsonObjectWithRepair(cleaned, {
      label,
      schemaHint,
      repair: async (repairPrompt: string) => {
        const repaired = await this.executor.execute(repairPrompt, {
          model: String(process.env.CREW_JSON_REPAIR_MODEL || this.getChatModel() || this.getReasoningModel() || '').trim() || undefined,
          temperature: 0,
          maxTokens: 1500
        });
        return String(repaired.result || '');
      }
    });
    
    console.log(`[JSON Parse] ${label}: ✓ success`);
    return parsed as T;
  }

  /**
   * Run dual-tier Level 2 planning
   * L2A: Decompose task into work graph
   * L2B: Validate work graph against policy
   */
  /**
   * Deep repo scan — reads key files directly and uses grep to find
   * task-relevant code. Gives L2 the same codebase awareness that
   * Cursor/Claude/Codex achieve through their iterative tool calls.
   */
  private async agenticRepoScan(task: string): Promise<string> {
    const cwd = process.cwd();
    const sections: string[] = [];

    try {
      // 1. Project structure
      const tree = this.shellSafe(`find ${cwd} -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.crew/*' | head -60`);
      if (tree) {
        const paths = tree.split('\n').map(p => relative(cwd, p)).filter(p => p && !p.startsWith('.'));
        sections.push(`## Project Structure\n${paths.join('\n')}`);
      }

      // 2. package.json
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
          sections.push(`## package.json\nName: ${pkg.name}\nVersion: ${pkg.version}\nScripts: ${Object.keys(pkg.scripts || {}).slice(0, 15).join(', ')}\nDeps: ${Object.keys(pkg.dependencies || {}).slice(0, 15).join(', ')}`);
        } catch {}
      }

      // 3. Keyword grep — find files related to the task
      const keywords = task.match(/\b(dashboard|widget|agent|health|failure|status|api|endpoint|component|tab|server|route|monitor)\b/gi) || [];
      const uniqueKw = [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 5);
      const relevantFiles = new Set<string>();

      for (const kw of uniqueKw) {
        const grep = this.shellSafe(`find ${cwd} -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" -o -name "*.html" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | xargs grep -l "${kw}" 2>/dev/null | head -8`);
        if (grep) {
          for (const f of grep.split('\n').filter(Boolean)) {
            relevantFiles.add(f);
          }
        }
      }

      if (relevantFiles.size > 0) {
        const relPaths = [...relevantFiles].map(f => relative(cwd, f)).slice(0, 15);
        sections.push(`## Files matching task keywords [${uniqueKw.join(', ')}]\n${relPaths.join('\n')}`);
      }

      // 4. Read the most relevant files (the key differentiator vs other engines)
      const topFiles = [...relevantFiles].slice(0, 5);
      for (const file of topFiles) {
        try {
          const content = await readFile(file, 'utf8');
          const relPath = relative(cwd, file);
          // Extract key patterns: exports, functions, API routes, class names
          const lines = content.split('\n');
          const keyLines = lines.filter(l =>
            /export |function |class |app\.(get|post|put)|router\.|endpoint|\/api\/|interface |type /.test(l)
          ).slice(0, 20);

          if (keyLines.length > 0) {
            sections.push(`## ${relPath} — key exports/routes\n\`\`\`\n${keyLines.join('\n')}\n\`\`\``);
          } else {
            // Just show first 40 lines
            sections.push(`## ${relPath} (first 40 lines)\n\`\`\`\n${lines.slice(0, 40).join('\n')}\n\`\`\``);
          }
        } catch {}
      }

      // 5. Git log
      const gitLog = this.shellSafe(`git -C ${cwd} log --oneline -8 2>/dev/null`);
      if (gitLog) sections.push(`## Recent commits\n${gitLog}`);

    } catch (err) {
      this.logger.warn(`Repo scan failed: ${(err as Error).message}`);
    }

    const result = sections.join('\n\n');
    console.log(`[L2 Planner] Repo scan: ${sections.length} sections, ${result.length} chars, ${[...new Set(sections.map(s => s.split('\n')[0]))].length} unique files read`);
    return result;
  }

  /**
   * Static repo scan fallback — uses shell commands directly.
   * Less accurate than agentic scan but faster and more reliable.
   */
  private async staticRepoScan(task: string): Promise<string> {
    const cwd = process.cwd();
    const sections: string[] = [];

    try {
      // 1. Project structure (top 2 levels, no node_modules)
      const tree = this.shellSafe(`find ${cwd} -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -80`);
      if (tree) {
        const relPaths = tree.split('\n').map(p => relative(cwd, p)).filter(Boolean);
        sections.push(`## Project Structure\n${relPaths.join('\n')}`);
      }

      // 2. Package.json for dependencies and scripts
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = await readFile(pkgPath, 'utf8').catch(() => '');
        if (pkg) {
          try {
            const parsed = JSON.parse(pkg);
            sections.push(`## package.json\nName: ${parsed.name}\nScripts: ${Object.keys(parsed.scripts || {}).join(', ')}\nDeps: ${Object.keys(parsed.dependencies || {}).join(', ')}`);
          } catch {}
        }
      }

      // 3. Grep for relevant patterns from the task
      const keywords = task.match(/\b(dashboard|widget|agent|health|api|endpoint|component|tab|server|route)\b/gi) || [];
      const uniqueKeywords = [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 4);
      for (const kw of uniqueKeywords) {
        const grepResult = this.shellSafe(`grep -rl "${kw}" ${cwd} --include="*.ts" --include="*.js" --include="*.mjs" --include="*.html" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null | head -10`);
        if (grepResult) {
          const files = grepResult.split('\n').map(p => relative(cwd, p)).filter(Boolean);
          sections.push(`## Files matching "${kw}"\n${files.join('\n')}`);
        }
      }

      // 4. Read key files that match the task (first 100 lines each)
      const relevantFiles = this.shellSafe(`grep -rl "${uniqueKeywords[0] || 'index'}" ${cwd} --include="*.ts" --include="*.js" --include="*.mjs" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null | head -3`);
      if (relevantFiles) {
        for (const file of relevantFiles.split('\n').filter(Boolean).slice(0, 3)) {
          const content = await readFile(file, 'utf8').catch(() => '');
          if (content) {
            const relPath = relative(cwd, file);
            const preview = content.split('\n').slice(0, 80).join('\n');
            sections.push(`## ${relPath} (first 80 lines)\n\`\`\`\n${preview}\n\`\`\``);
          }
        }
      }

      // 5. Git recent changes
      const gitLog = this.shellSafe(`git -C ${cwd} log --oneline -10 2>/dev/null`);
      if (gitLog) sections.push(`## Recent git commits\n${gitLog}`);

    } catch (err) {
      this.logger.warn(`Repo scan failed: ${(err as Error).message}`);
    }

    const repoContext = sections.join('\n\n');
    if (repoContext) {
      console.log(`[L2 Planner] Repo scan: ${sections.length} sections, ${repoContext.length} chars`);
    }
    return repoContext;
  }

  private shellSafe(cmd: string): string {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  }

  async plan(
    task: string,
    context: string = '',
    traceId: string
  ): Promise<DualL2Result> {
    const executionPath: string[] = ['dual-l2-planner'];

    try {
      if (this.isLightweightTask(task, context)) {
        executionPath.push('l2a-lightweight');
        return this.buildLightweightPlan(task, context, traceId);
      }

      // L2-PHASE-0: Agentic repo scan — uses L3 tools (read_file, glob, grep, git)
      // to build codebase context like Cursor/Claude/Codex do
      executionPath.push('l2-agentic-scan');
      const repoContext = await this.agenticRepoScan(task);
      const enrichedContext = repoContext ? `${context}\n\n${repoContext}` : context;

      // L2A-PHASE-0: Generate planning artifacts (PDD, ROADMAP, ARCH)
      executionPath.push('l2a-planning-artifacts');
      const planningArtifacts = await this.generatePlanningArtifacts(task, enrichedContext, traceId);

      // L2A-PHASE-1: Decomposer - break down the task with artifacts
      executionPath.push('l2a-decomposer');
      const rawGraph = await this.decompose(task, enrichedContext, traceId, planningArtifacts);
      const workGraph = this.enforceMandatoryExecutionGraph(rawGraph);

      // L2B: Policy Validator - validate the plan
      executionPath.push('l2b-policy-validator');
      const validation = await this.validate(workGraph, task, traceId);

      return {
        workGraph,
        validation,
        traceId,
        executionPath,
        artifacts: planningArtifacts
      };
    } catch (err) {
      this.logger.error(`Dual-L2 planning failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * L2A-PHASE-0: Generate planning artifacts before decomposition
  /**
   * Generate planning artifacts in 3 passes to avoid JSON truncation
   * Pass 1: Core docs (PDD, ROADMAP, ARCH) + acceptance criteria
   * Pass 2: Implementation docs (SCAFFOLD, CONTRACT-TESTS)
   * Pass 3: Quality gates (DOD, GOLDEN-BENCHMARKS)
   */
  private async generatePlanningArtifacts(
    task: string,
    context: string,
    traceId: string
  ): Promise<PlanningArtifacts> {
    console.log('[L2A Planning] Multi-pass artifact generation...');
    
    // Pass 1: Core planning artifacts
    console.log('[L2A Planning] Pass 1/3: Core docs (PDD + ROADMAP + ARCH)...');
    const coreResult = await this.generateCoreArtifacts(task, context, traceId);
    
    // Pass 2: Implementation artifacts (use core context)
    console.log('[L2A Planning] Pass 2/3: Implementation docs (SCAFFOLD + CONTRACT-TESTS)...');
    const implResult = await this.generateImplArtifacts(task, coreResult, traceId);
    
    // Pass 3: Quality gate artifacts (use core + impl context)
    console.log('[L2A Planning] Pass 3/3: Quality gates (DOD + GOLDEN-BENCHMARKS)...');
    const gateResult = await this.generateGateArtifacts(task, coreResult, traceId);
    
    // Write all artifacts to disk
    const baseDir = process.env.CREW_PIPELINE_ARTIFACT_DIR
      ? resolve(process.env.CREW_PIPELINE_ARTIFACT_DIR)
      : resolve(process.cwd(), '.crew', 'pipeline-artifacts', traceId);
    await mkdir(baseDir, { recursive: true });
    
    const files = {
      pdd: join(baseDir, 'PDD.md'),
      roadmap: join(baseDir, 'ROADMAP.md'),
      architecture: join(baseDir, 'ARCH.md'),
      scaffold: join(baseDir, 'SCAFFOLD.md'),
      contractTests: join(baseDir, 'CONTRACT-TESTS.md'),
      definitionOfDone: join(baseDir, 'DOD.md'),
      goldenBenchmarks: join(baseDir, 'GOLDEN-BENCHMARKS.md')
    };
    
    await Promise.all([
      writeFile(files.pdd, coreResult.pdd, 'utf8'),
      writeFile(files.roadmap, coreResult.roadmap, 'utf8'),
      writeFile(files.architecture, coreResult.architecture, 'utf8'),
      writeFile(files.scaffold, implResult.scaffold, 'utf8'),
      writeFile(files.contractTests, implResult.contractTests, 'utf8'),
      writeFile(files.definitionOfDone, gateResult.definitionOfDone, 'utf8'),
      writeFile(files.goldenBenchmarks, gateResult.goldenBenchmarks, 'utf8')
    ]);
    
    console.log('[L2A Planning] ✅ All artifacts generated:');
    console.log(`  PDD.md: ${coreResult.pdd.length} chars`);
    console.log(`  ROADMAP.md: ${coreResult.roadmap.length} chars`);
    console.log(`  ARCH.md: ${coreResult.architecture.length} chars`);
    console.log(`  SCAFFOLD.md: ${implResult.scaffold.length} chars`);
    console.log(`  CONTRACT-TESTS.md: ${implResult.contractTests.length} chars`);
    console.log(`  DOD.md: ${gateResult.definitionOfDone.length} chars`);
    console.log(`  GOLDEN-BENCHMARKS.md: ${gateResult.goldenBenchmarks.length} chars`);
    console.log(`  Dir: ${baseDir}`);
    
    return {
      pdd: coreResult.pdd,
      roadmap: coreResult.roadmap,
      architecture: coreResult.architecture,
      scaffold: implResult.scaffold,
      contractTests: implResult.contractTests,
      definitionOfDone: gateResult.definitionOfDone,
      goldenBenchmarks: gateResult.goldenBenchmarks,
      acceptanceCriteria: coreResult.acceptanceCriteria,
      outputDir: baseDir,
      files
    };
  }

  /**
   * Pass 1: Generate core planning artifacts (PDD + ROADMAP + ARCH + acceptance criteria)
   */
  private async generateCoreArtifacts(
    task: string,
    context: string,
    traceId: string
  ): Promise<{ pdd: string; roadmap: string; architecture: string; acceptanceCriteria: string[] }> {
    const overlays: PromptOverlay[] = [
      { type: 'task', content: `Task: ${task}`, priority: 1 }
    ];

    if (context) {
      overlays.push({ type: 'context', content: `Context:\n${context}`, priority: 2 });
    }

    overlays.push({
      type: 'constraints',
      content: `Generate THREE core planning artifacts as compact bullet lists:

**1. PDD.md** (Product Design Doc):
- Overview (1-2 sentences)
- Requirements (bullet list, max 5 items)
- Success criteria (bullet list, max 3 items)
- File structure (bullet list of files to create)

**2. ROADMAP.md**:
- Phase 1, Phase 2, Phase 3 (bullet list per phase)
- Dependencies (→ syntax: "task-2 → task-5")
- Critical path (ordered list of must-complete tasks)

**3. ARCH.md**:
- Tech stack (bullet list: framework, language, key libs)
- Module structure (bullet list of modules with 1-line purpose)
- Patterns (e.g., "API format: REST JSON", "naming: camelCase")
- **CRITICAL: Module system** - Inspect test files mentioned in task/context:
  - If you see \`import { something } from\` in tests → write: "Module system: **ESM** - use \`export\` keyword"
  - If you see \`const x = require()\` in tests → write: "Module system: **CommonJS** - use \`module.exports\`"
  - Implementation code MUST use the SAME module system as tests

Return ONLY valid JSON (no markdown, no code fences):
{
  "pdd": "# PDD\\n\\n## Overview\\n- bullet\\n\\n## Requirements\\n- req1\\n- req2",
  "roadmap": "# ROADMAP\\n\\n## Phase 1\\n- task1\\n- task2",
  "architecture": "# ARCH\\n\\n## Stack\\n- Node 20\\n- TypeScript\\n- Module system: **ESM** - use export keyword",
  "acceptanceCriteria": ["ac-1: criteria", "ac-2: criteria"]
}

CRITICAL: Escape \\n for newlines, \\" for quotes. Return JSON only.`,
      priority: 3
    });

    const composedPrompt = this.composer.compose('specialist-pm-v1', overlays, `${traceId}-core`);
    const l2aModel = this.getL2AModel();
    console.log(`[DualL2] Core artifacts - model: ${l2aModel || 'undefined (will use executor default)'}`);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: l2aModel,
      temperature: 0,  // Deterministic for JSON
      maxTokens: 4000,
      jsonMode: true  // Structured output where supported
    });

    if (!result.success) {
      throw new Error(`Core artifacts generation failed: ${result.result}`);
    }

    const parsed = await this.parseStructuredJson<{
      pdd: string;
      roadmap: string;
      architecture: string;
      acceptanceCriteria: string[];
    }>(
      result.result,
      'Core artifacts (Pass 1)',
      '{"pdd":"...","roadmap":"...","architecture":"...","acceptanceCriteria":["ac-1"]}'
    );

    return {
      pdd: String(parsed.pdd || `# PDD\\n\\n## Task\\n${task}\\n`).trim(),
      roadmap: String(parsed.roadmap || `# ROADMAP\\n\\n- Implement: ${task}\\n`).trim(),
      architecture: String(parsed.architecture || `# ARCH\\n\\n## System\\nDerived from requirements.\\n`).trim(),
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.map(v => String(v).trim()).filter(Boolean)
        : []
    };
  }

  /**
   * Pass 2: Generate implementation artifacts (SCAFFOLD + CONTRACT-TESTS)
   */
  private async generateImplArtifacts(
    task: string,
    coreContext: { pdd: string; roadmap: string; architecture: string; acceptanceCriteria: string[] },
    traceId: string
  ): Promise<{ scaffold: string; contractTests: string }> {
    const overlays: PromptOverlay[] = [
      { type: 'task', content: `Task: ${task}`, priority: 1 },
      {
        type: 'context',
        content: `**Core Planning Context:**
PDD Summary: ${coreContext.pdd.slice(0, 300)}...
ROADMAP Summary: ${coreContext.roadmap.slice(0, 200)}...
ARCH Summary: ${coreContext.architecture.slice(0, 200)}...
Acceptance Criteria: ${coreContext.acceptanceCriteria.slice(0, 3).join('; ')}`,
        priority: 2
      },
      {
        type: 'constraints',
        content: `Generate TWO implementation artifacts as compact bullet lists:

**1. SCAFFOLD.md** (Bootstrap checklist):
- File tree (bullet list: path + 1-line purpose)
- Config files needed (package.json, tsconfig.json, etc.)
- Build smoke command (e.g., "npm run build")
- Test smoke command (e.g., "npm test")

**2. CONTRACT-TESTS.md**:
- Map each acceptance criterion to 1-2 tests
- Format: "Test ac-1: Given X, When Y, Then Z"
- Include file path where test should live

Return ONLY valid JSON (no markdown, no code fences):
{
  "scaffold": "# SCAFFOLD\\n\\n## Files\\n- src/index.ts: entry point\\n\\n## Build\\n- npm run build",
  "contractTests": "# CONTRACT TESTS\\n\\n- Test ac-1: Given ..., When ..., Then ...\\n  File: tests/ac1.test.ts"
}

CRITICAL: Escape \\n for newlines, \\" for quotes. Return JSON only.`,
        priority: 3
      }
    ];

    const composedPrompt = this.composer.compose('specialist-pm-v1', overlays, `${traceId}-impl`);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getL2AModel(),
      temperature: 0,  // Deterministic for JSON
      maxTokens: 3000,
      jsonMode: true
    });

    if (!result.success) {
      throw new Error(`Implementation artifacts generation failed: ${result.result}`);
    }

    const parsed = await this.parseStructuredJson<{
      scaffold: string;
      contractTests: string;
    }>(
      result.result,
      'Implementation artifacts (Pass 2)',
      '{"scaffold":"...","contractTests":"..."}'
    );

    return {
      scaffold: String(parsed.scaffold || `# SCAFFOLD\\n\\n- Initialize project\\n- Add scripts\\n`).trim(),
      contractTests: String(parsed.contractTests || `# CONTRACT TESTS\\n\\n- Map acceptance criteria to tests\\n`).trim()
    };
  }

  /**
   * Pass 3: Generate quality gate artifacts (DOD + GOLDEN-BENCHMARKS)
   */
  private async generateGateArtifacts(
    task: string,
    coreContext: { pdd: string; roadmap: string; acceptanceCriteria: string[] },
    traceId: string
  ): Promise<{ definitionOfDone: string; goldenBenchmarks: string }> {
    const overlays: PromptOverlay[] = [
      { type: 'task', content: `Task: ${task}`, priority: 1 },
      {
        type: 'context',
        content: `**Planning Context:**
Acceptance Criteria: ${coreContext.acceptanceCriteria.join('; ')}
PDD Summary: ${coreContext.pdd.slice(0, 200)}...`,
        priority: 2
      },
      {
        type: 'constraints',
        content: `Generate TWO quality gate artifacts as compact checklists:

**1. DOD.md** (Definition of Done):
- Build checklist (e.g., "✓ npm run build succeeds")
- Test checklist (e.g., "✓ all tests pass", "✓ coverage >80%")
- QA checklist (e.g., "✓ no linter errors")
- Security checklist (e.g., "✓ no hardcoded secrets")

**2. GOLDEN-BENCHMARKS.md**:
- Benchmark suite command (e.g., "npm run benchmark")
- Pass criteria (e.g., "✓ all tasks <500ms", "✓ cost <$0.10")
- When to run (e.g., "on major refactors", "before release")

Return ONLY valid JSON (no markdown, no code fences):
{
  "definitionOfDone": "# DOD\\n\\n## Build\\n- ✓ npm run build\\n\\n## Tests\\n- ✓ all pass",
  "goldenBenchmarks": "# GOLDEN BENCHMARKS\\n\\n## Command\\n- npm run benchmark\\n\\n## Criteria\\n- ✓ <500ms"
}

CRITICAL: Escape \\n for newlines, \\" for quotes. Return JSON only.`,
        priority: 3
      }
    ];

    const composedPrompt = this.composer.compose('specialist-pm-v1', overlays, `${traceId}-gates`);
    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getL2AModel(),
      temperature: 0,  // Deterministic for JSON
      maxTokens: 2000,
      jsonMode: true
    });

    if (!result.success) {
      throw new Error(`Quality gate artifacts generation failed: ${result.result}`);
    }

    const parsed = await this.parseStructuredJson<{
      definitionOfDone: string;
      goldenBenchmarks: string;
    }>(
      result.result,
      'Quality gates (Pass 3)',
      '{"definitionOfDone":"...","goldenBenchmarks":"..."}'
    );

    return {
      definitionOfDone: String(parsed.definitionOfDone || `# DOD\\n\\n- Build passes\\n- Tests pass\\n`).trim(),
      goldenBenchmarks: String(parsed.goldenBenchmarks || `# GOLDEN BENCHMARKS\\n\\n- Run on major changes\\n`).trim()
    };
  }


  /**
   * L2A: Decompose task into work graph
   */
  private async decompose(
    task: string,
    context: string,
    traceId: string,
    planningArtifacts?: PlanningArtifacts
  ): Promise<WorkGraph> {
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `User task: ${task}`,
        priority: 1
      }
    ];

    if (context) {
      overlays.push({
        type: 'context',
        content: `Context:\n${context}`,
        priority: 2
      });
    }

    // Add planning artifacts to context if available
    if (planningArtifacts) {
      overlays.push({
        type: 'context',
        content: `Planning artifacts for decomposition:
[PDD.md]
${planningArtifacts.pdd}

[ROADMAP.md]
${planningArtifacts.roadmap}

[ARCH.md]
${planningArtifacts.architecture}

[SCAFFOLD.md]
${planningArtifacts.scaffold}

[CONTRACT-TESTS.md]
${planningArtifacts.contractTests}

[DOD.md]
${planningArtifacts.definitionOfDone}

[GOLDEN-BENCHMARKS.md]
${planningArtifacts.goldenBenchmarks}`,
        priority: 2
      });
    }

    overlays.push({
      type: 'constraints',
      content: `Return ONLY valid JSON with this structure:
{
  "units": [
    {
      "id": "unique-id",
      "description": "what to do",
      "requiredPersona": "executor-code",
      "dependencies": ["id1", "id2"],
      "estimatedComplexity": "low|medium|high",
      "requiredCapabilities": ["code-generation", "file-write", "code-reading"],
      "sourceRefs": ["PDD.md#section", "ROADMAP.md#milestone", "ARCH.md#decision", "CONTRACT-TESTS.md#case", "DOD.md#checklist"],
      "allowedPaths": ["src/auth/jwt.ts", "test/auth/jwt.test.ts"],
      "verification": ["Run npm test -- jwt", "Confirm src/auth/jwt.ts was updated"],
      "escalationHints": ["Escalate if auth logic requires changes outside src/auth", "Escalate after two failed verification attempts"],
      "maxFilesTouched": 2
    }
  ],
  "totalComplexity": 1-10,
  "requiredPersonas": ["executor-code"],
  "estimatedCost": 0.001
}

Rules:
- CRITICAL: In standalone crew-cli mode, ALL units MUST use requiredPersona="executor-code" (the local L3 worker). Do NOT use crew-coder, crew-qa, or any remote agent personas.
- requiredCapabilities can be: ["code-generation", "file-write", "code-reading"] only. NO "filesystem" or other non-existent capabilities.
- Every unit must include at least one sourceRefs entry.
- sourceRefs must reference one or more of: PDD.md, ROADMAP.md, ARCH.md, CONTRACT-TESTS.md, DOD.md, SCAFFOLD.md, GOLDEN-BENCHMARKS.md.
- Every unit must include explicit allowedPaths. Use the smallest concrete file list possible.
- Every unit must include explicit verification steps. Verification must mention exact commands or exact file-state checks.
- Every unit must include escalationHints. Tell the worker when to stop and escalate.
- maxFilesTouched must be 1-3 for normal tasks. Only use a higher number if absolutely necessary.
- Keep each unit tightly scoped to one artifact or one small cluster of files. Do not create broad "entire project" tasks.
- DO NOT wrap in markdown code fences (NO \`\`\`json)
- Start response with { and end with }
- Return raw JSON only`,
      priority: 3
    });

    const composedPrompt = this.composer.compose('decomposer-v1', overlays, traceId);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getL2AModel(),  // Dedicated L2A model when configured
      temperature: 0.3,
      maxTokens: 8000  // Increased for complete work graph JSON (was 4000)
    });

    if (!result.success) {
      throw new Error(`Decomposer failed: ${result.result}`);
    }

    // Debug: write BEFORE parsing
    const rawOutput = result.result || '';
    if (process.env.DEBUG_JSON_PARSE) {
      const fs = await import('fs');
      fs.writeFileSync('/tmp/gemini-decomposer-response.txt', `Length: ${rawOutput.length}\n\n${rawOutput}`);
      console.log('[DualL2] Debug: wrote decomposer response to /tmp/gemini-decomposer-response.txt');
    }

    const workGraph = await this.parseStructuredJson<WorkGraph>(
      rawOutput,
      'Decomposer',
      '{"units":[{"id":"unit-1","description":"Update src/example.ts","requiredPersona":"executor-code","dependencies":[],"estimatedComplexity":"low","requiredCapabilities":["code-generation","file-write"],"sourceRefs":["ROADMAP.md#item"],"allowedPaths":["src/example.ts"],"verification":["Confirm src/example.ts changed"],"escalationHints":["Escalate if another file must be edited"],"maxFilesTouched":1}],"totalComplexity":1,"requiredPersonas":["executor-code"],"estimatedCost":0.01}'
    );
    for (const unit of (workGraph.units || [])) {
      if (!Array.isArray(unit.sourceRefs) || unit.sourceRefs.length === 0) {
        unit.sourceRefs = ['PDD.md#overview', 'ROADMAP.md#milestones', 'ARCH.md#architecture', 'CONTRACT-TESTS.md#cases', 'DOD.md#checklist'];
      }
      if (!Array.isArray(unit.allowedPaths)) {
        unit.allowedPaths = [];
      }
      if (!Array.isArray(unit.verification) || unit.verification.length === 0) {
        unit.verification = ['Report the exact files changed.'];
      }
      if (!Array.isArray(unit.escalationHints) || unit.escalationHints.length === 0) {
        unit.escalationHints = ['Escalate after two failed verification attempts.'];
      }
      if (typeof unit.maxFilesTouched !== 'number' || !Number.isFinite(unit.maxFilesTouched) || unit.maxFilesTouched < 1) {
        unit.maxFilesTouched = unit.allowedPaths.length > 0 ? unit.allowedPaths.length : 1;
      }
    }
    
    // Attach planning artifacts to work graph for L3 workers
    workGraph.planningArtifacts = planningArtifacts;
    
    return workGraph;
  }

  /**
   * L2B: Validate work graph against policy
   */
  private async validate(
    workGraph: WorkGraph,
    originalTask: string,
    traceId: string
  ): Promise<PolicyValidation> {
    const overlays: PromptOverlay[] = [
      {
        type: 'safety',
        content: `Original task: ${originalTask}

Work graph to validate:
${JSON.stringify(workGraph, null, 2)}

Available capability matrix (crew-cli standalone mode):
- executor-code: ALL basic capabilities (code-generation, file-write, code-reading, testing)

Validate for:
1. Security risks (file access outside project, network calls, shell execution)
2. Resource costs (estimated tokens, time, API calls)
3. Persona requirements (ALL units must use requiredPersona="executor-code" in standalone mode)
4. Fallback strategy (what if a unit fails?)

CRITICAL VALIDATIONS:
- REJECT if any unit has requiredPersona != "executor-code" (remote agents like crew-coder, crew-qa not available in standalone mode)
- APPROVE all file operations to project directory (expected and safe in standalone mode)
- APPROVE all requiredCapabilities for executor-code (no capability restrictions for local L3 worker)

Return ONLY valid JSON:
{
  "approved": true|false,
  "riskLevel": "low|medium|high|critical",
  "concerns": ["list", "of", "concerns"],
  "recommendations": ["list", "of", "recommendations"],
  "fallbackStrategy": "what to do if this fails",
  "estimatedCost": 0.001
}`,
        priority: 1
      },
      {
        type: 'constraints',
        content: `Cost limit: $0.50 per task
Risk tolerance: medium
APPROVE: All executor-code units with any capabilities
APPROVE: File writes to project directory
REJECT: Remote agent personas (crew-coder, crew-qa, etc.) - not available in standalone mode`,
        priority: 2
      }
    ];

    const composedPrompt = this.composer.compose('policy-validator-v1', overlays, traceId);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getL2BModel(),  // Dedicated L2B model when configured
      temperature: 0.1,
      maxTokens: 1000
    });

    if (!result.success) {
      throw new Error(`Policy validator failed: ${result.result}`);
    }

    const validation = await this.parseStructuredJson<PolicyValidation>(
      result.result,
      'Policy validator',
      '{"approved":true,"riskLevel":"low","concerns":[],"recommendations":[],"estimatedCost":0.01}'
    );
    return validation;
  }

  /**
   * Get composed prompts for trace debugging
   */
  getTrace(traceId: string) {
    return this.composer.getTrace(traceId);
  }

  private enforceMandatoryExecutionGraph(workGraph: WorkGraph): WorkGraph {
    const units = Array.isArray(workGraph.units) ? [...workGraph.units] : [];
    const byId = new Map(units.map(u => [u.id, u]));
    const gateIds = new Set(['scaffold-bootstrap', 'contract-tests-from-pdd', 'gate-definition-of-done', 'gate-golden-benchmark-suite']);

    const addUnit = (unit: WorkUnit) => {
      if (!byId.has(unit.id)) {
        units.push(unit);
        byId.set(unit.id, unit);
      }
    };

    addUnit({
      id: 'scaffold-bootstrap',
      description: 'Mandatory scaffold phase: produce project skeleton, starter files, and build/test smoke scaffolding exactly per SCAFFOLD.md.',
      requiredPersona: 'executor-code',
      dependencies: [],
      estimatedComplexity: 'low',
      requiredCapabilities: ['scaffolding', 'code-generation'],
      sourceRefs: ['SCAFFOLD.md#structure', 'ARCH.md#module-structure'],
      allowedPaths: ['.'],
      verification: ['Confirm the scaffold files required by SCAFFOLD.md now exist.'],
      escalationHints: ['Escalate if the scaffold requires changes outside the project workspace.'],
      maxFilesTouched: 3
    });

    addUnit({
      id: 'contract-tests-from-pdd',
      description: 'Generate contract tests from PDD acceptance criteria and map each test to acceptance IDs before feature implementation.',
      requiredPersona: 'executor-code',
      dependencies: ['scaffold-bootstrap'],
      estimatedComplexity: 'medium',
      requiredCapabilities: ['code-generation', 'file-write', 'code-reading'],
      sourceRefs: ['PDD.md#success-criteria', 'CONTRACT-TESTS.md#cases'],
      allowedPaths: ['test/', 'tests/', '__tests__/'],
      verification: ['Confirm contract tests were created from CONTRACT-TESTS.md cases.'],
      escalationHints: ['Escalate if the correct test directory cannot be determined.'],
      maxFilesTouched: 3
    });

    for (const unit of units) {
      if (gateIds.has(unit.id)) continue;
      const deps = new Set(Array.isArray(unit.dependencies) ? unit.dependencies : []);
      deps.add('scaffold-bootstrap');
      deps.add('contract-tests-from-pdd');
      unit.dependencies = Array.from(deps).filter(dep => dep !== unit.id);
    }

    const implUnitIds = units
      .filter(u => !gateIds.has(u.id))
      .map(u => u.id);

    addUnit({
      id: 'gate-definition-of-done',
      description: 'Definition of done gate: verify completion criteria from DOD.md are met and return explicit pass/fail with failed checks.',
      requiredPersona: 'executor-code',
      dependencies: implUnitIds,
      estimatedComplexity: 'low',
      requiredCapabilities: ['code-reading'],
      sourceRefs: ['DOD.md#checklist', 'PDD.md#success-criteria'],
      allowedPaths: ['.'],
      verification: ['Return explicit pass/fail against DOD.md and list failed checks if any.'],
      escalationHints: ['Escalate if the definition-of-done checks require missing artifacts.'],
      maxFilesTouched: 1
    });

    addUnit({
      id: 'gate-golden-benchmark-suite',
      description: 'Run golden benchmark suite for major changes using GOLDEN-BENCHMARKS.md and report command outputs, timing, and pass/fail.',
      requiredPersona: 'executor-code',
      dependencies: ['gate-definition-of-done'],
      estimatedComplexity: 'medium',
      requiredCapabilities: ['code-reading'],
      sourceRefs: ['GOLDEN-BENCHMARKS.md#suite', 'ROADMAP.md#critical-path'],
      allowedPaths: ['.'],
      verification: ['Report the benchmark command, timing, and pass/fail outcome.'],
      escalationHints: ['Escalate if the benchmark command is missing or ambiguous.'],
      maxFilesTouched: 1
    });

    for (const unit of units) {
      unit.dependencies = Array.from(new Set(unit.dependencies || [])).filter(dep => dep !== unit.id);
    }

    return {
      ...workGraph,
      units,
      requiredPersonas: Array.from(new Set(units.map(u => u.requiredPersona))),
      estimatedCost: Math.max(Number(workGraph.estimatedCost || 0), 0) + 0.002
    };
  }
}
