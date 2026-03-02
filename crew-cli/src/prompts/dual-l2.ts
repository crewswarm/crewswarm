/**
 * Dual-Tier Level 2 Planning System
 * L2A: Decomposer - breaks complex tasks into work graphs
 * L2B: Policy Validator - validates plans for risk/cost/compliance
 */

import { PromptComposer, PromptOverlay } from './registry.js';
import { LocalExecutor } from '../executor/local.js';
import { Logger } from '../utils/logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseJsonObjectWithRepair } from '../utils/structured-json.js';

export interface WorkUnit {
  id: string;
  description: string;
  requiredPersona: string;
  dependencies: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  requiredCapabilities: string[];
  sourceRefs?: string[];
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
  planningArtifacts?: PlanningArtifacts;
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

  private async parseStructuredJson<T>(raw: string, label: string, schemaHint?: string): Promise<T> {
    const parsed = await parseJsonObjectWithRepair(raw, {
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
    return parsed as T;
  }

  /**
   * Run dual-tier Level 2 planning
   * L2A: Decompose task into work graph
   * L2B: Validate work graph against policy
   */
  async plan(
    task: string,
    context: string = '',
    traceId: string
  ): Promise<DualL2Result> {
    const executionPath: string[] = ['dual-l2-planner'];

    try {
      // L2A-PHASE-0: Generate planning artifacts (PDD, ROADMAP, ARCH)
      executionPath.push('l2a-planning-artifacts');
      const planningArtifacts = await this.generatePlanningArtifacts(task, context, traceId);

      // L2A-PHASE-1: Decomposer - break down the task with artifacts
      executionPath.push('l2a-decomposer');
      const rawGraph = await this.decompose(task, context, traceId, planningArtifacts);
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
   * Creates PDD, ROADMAP, and ARCH docs that all workers can reference
   */
  private async generatePlanningArtifacts(
    task: string,
    context: string,
    traceId: string
  ): Promise<PlanningArtifacts> {
    console.log('[L2A Planning] Generating PDD.md + ROADMAP.md + ARCH.md...');
    
    const overlays: PromptOverlay[] = [
      {
        type: 'task',
        content: `Task: ${task}`,
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

    overlays.push({
      type: 'constraints',
      content: `Generate SEVEN planning artifacts:

1. **PDD.md** (Product Design Doc):
   - Overview & Goals
   - User stories / Requirements
   - Success criteria
   - Technical constraints
   - File structure (what files will be created)

2. **ROADMAP.md**:
   - Milestone breakdown
   - Task dependencies
   - Estimated effort per task
   - Critical path

3. **ARCH.md** (Architecture):
   - Key technology decisions (e.g., VS Code Extension API, not Chrome)
   - Module structure
   - Integration points
   - Shared patterns (API format, naming conventions)

4. **SCAFFOLD.md** (Mandatory scaffold gate):
   - Required starter file tree
   - Mandatory config files and scripts
   - Build/lint/test smoke commands that must pass before implementation
   - Minimal bootstrap code/contracts per module

5. **CONTRACT-TESTS.md**:
   - Generate test cases directly from acceptance criteria in PDD
   - Include Given/When/Then style checks
   - Map each test to at least one acceptance criterion ID

6. **DOD.md** (Definition of Done gate):
   - Completion checklist
   - Required validations
   - Quality/security requirements
   - Explicit fail conditions

7. **GOLDEN-BENCHMARKS.md**:
   - Benchmark suite commands and expected pass criteria
   - Metrics to collect (time/cost/quality)
   - Must-run condition for major changes

Return as STRICT valid JSON with properly escaped strings:
{
  "pdd": "Content with \\n for newlines",
  "roadmap": "Content with \\n for newlines",
  "architecture": "Content with \\n for newlines",
  "scaffold": "Content with \\n for newlines",
  "contractTests": "Content with \\n for newlines",
  "definitionOfDone": "Content with \\n for newlines",
  "goldenBenchmarks": "Content with \\n for newlines",
  "acceptanceCriteria": ["ac-1: ...", "ac-2: ..."]
}

CRITICAL JSON RULES:
- All newlines MUST be escaped as \\n
- All quotes MUST be escaped as \\"  
- Return ONLY the raw JSON object
- DO NOT wrap in markdown code fences (NO \`\`\`json)
- DO NOT add any text before or after the JSON
- DO NOT include literal line breaks inside string values
- Start response with { and end with }

CRITICAL:
- If task mentions "VS Code extension", do NOT create Chrome extension docs.
- Keep artifacts implementation-focused and executable by coding workers.
- Return JSON only.`,
      priority: 3
    });

    const composedPrompt = this.composer.compose('specialist-pm-v1', overlays, `${traceId}-planning`);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getReasoningModel(),
      temperature: 0.4,
      maxTokens: 8000  // Increased for planning artifacts (PDD + ROADMAP + ARCH)
    });

    if (!result.success) {
      throw new Error(`Planning artifacts generation failed: ${result.result}`);
    }

    // Parse JSON response - extract/repair for model quirks
    const jsonText = result.result;

    // Debug: write full response to file
    if (process.env.DEBUG_JSON_PARSE) {
      const debugPath = '/tmp/gemini-planning-response.txt';
      await writeFile(debugPath, `Length: ${jsonText.length}\n\n${jsonText}`, 'utf8');
      console.log(`[DualL2] Debug: wrote full response to ${debugPath}`);
    }
    const artifacts = await this.parseStructuredJson<{
      pdd?: string;
      roadmap?: string;
      architecture?: string;
      scaffold?: string;
      contractTests?: string;
      definitionOfDone?: string;
      goldenBenchmarks?: string;
      acceptanceCriteria?: string[];
    }>(
      jsonText,
      'Planning artifacts',
      '{"pdd":"...","roadmap":"...","architecture":"...","scaffold":"...","contractTests":"...","definitionOfDone":"...","goldenBenchmarks":"...","acceptanceCriteria":["ac-1"]}'
    );
    console.log('[DualL2] ✓ JSON parsed successfully');

    const pdd = String(artifacts.pdd || '').trim() || `# PDD\n\n## Task\n${task}\n`;
    const roadmap = String(artifacts.roadmap || '').trim() || `# ROADMAP\n\n- Implement task: ${task}\n`;
    const architecture = String(artifacts.architecture || '').trim() || `# ARCH\n\n## System\nDerived from task requirements.\n`;
    const scaffold = String(artifacts.scaffold || '').trim() || `# SCAFFOLD\n\n- Initialize project structure\n- Add build and test scripts\n`;
    const contractTests = String(artifacts.contractTests || '').trim() || `# CONTRACT TESTS\n\n- Map acceptance criteria to tests\n`;
    const definitionOfDone = String(artifacts.definitionOfDone || '').trim() || `# DEFINITION OF DONE\n\n- Build passes\n- Tests pass\n- QA approved\n`;
    const goldenBenchmarks = String(artifacts.goldenBenchmarks || '').trim() || `# GOLDEN BENCHMARKS\n\n- Run benchmark suite for major changes\n`;
    const acceptanceCriteria = Array.isArray(artifacts.acceptanceCriteria)
      ? artifacts.acceptanceCriteria.map(v => String(v).trim()).filter(Boolean)
      : [];

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
      writeFile(files.pdd, pdd, 'utf8'),
      writeFile(files.roadmap, roadmap, 'utf8'),
      writeFile(files.architecture, architecture, 'utf8'),
      writeFile(files.scaffold, scaffold, 'utf8'),
      writeFile(files.contractTests, contractTests, 'utf8'),
      writeFile(files.definitionOfDone, definitionOfDone, 'utf8'),
      writeFile(files.goldenBenchmarks, goldenBenchmarks, 'utf8')
    ]);
    
    console.log('[L2A Planning] ✅ Generated artifacts:');
    console.log(`  PDD.md: ${pdd.length} chars`);
    console.log(`  ROADMAP.md: ${roadmap.length} chars`);
    console.log(`  ARCH.md: ${architecture.length} chars`);
    console.log(`  SCAFFOLD.md: ${scaffold.length} chars`);
    console.log(`  CONTRACT-TESTS.md: ${contractTests.length} chars`);
    console.log(`  DOD.md: ${definitionOfDone.length} chars`);
    console.log(`  GOLDEN-BENCHMARKS.md: ${goldenBenchmarks.length} chars`);
    console.log(`  Dir: ${baseDir}`);

    return {
      pdd,
      roadmap,
      architecture,
      scaffold,
      contractTests,
      definitionOfDone,
      goldenBenchmarks,
      acceptanceCriteria,
      outputDir: baseDir,
      files
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
      "requiredPersona": "executor-code|executor-chat|specialist-qa|specialist-pm|specialist-security|specialist-frontend|specialist-backend|specialist-research|specialist-ml|specialist-github|specialist-docs|crew-coder|crew-coder-front|crew-coder-back|crew-frontend|crew-qa|crew-fixer|crew-security|crew-pm|crew-main|crew-orchestrator|orchestrator|crew-architect|crew-researcher|crew-copywriter|crew-seo|crew-ml|crew-github|crew-mega|crew-telegram|crew-whatsapp",
      "dependencies": ["id1", "id2"],
      "estimatedComplexity": "low|medium|high",
      "requiredCapabilities": ["code-generation", "testing", etc],
      "sourceRefs": ["PDD.md#section", "ROADMAP.md#milestone", "ARCH.md#decision", "CONTRACT-TESTS.md#case", "DOD.md#checklist"]
    }
  ],
  "totalComplexity": 1-10,
  "requiredPersonas": ["list", "of", "personas"],
  "estimatedCost": 0.001
}

Rules:
- Every unit must include at least one sourceRefs entry.
- sourceRefs must reference one or more of: PDD.md, ROADMAP.md, ARCH.md, CONTRACT-TESTS.md, DOD.md, SCAFFOLD.md, GOLDEN-BENCHMARKS.md.
- DO NOT wrap in markdown code fences (NO \`\`\`json)
- Start response with { and end with }
- Return raw JSON only`,
      priority: 3
    });

    const composedPrompt = this.composer.compose('decomposer-v1', overlays, traceId);

    const result = await this.executor.execute(composedPrompt.finalPrompt, {
      model: this.getL2AModel(),  // Dedicated L2A model when configured
      temperature: 0.3,
      maxTokens: 4000  // Increased for decomposition (was 2000)
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
      '{"units":[{"id":"unit-1","description":"...","requiredPersona":"crew-coder","dependencies":[],"estimatedComplexity":"low","requiredCapabilities":["coding"]}],"totalComplexity":1,"requiredPersonas":["crew-coder"],"estimatedCost":0.01}'
    );
    for (const unit of (workGraph.units || [])) {
      if (!Array.isArray(unit.sourceRefs) || unit.sourceRefs.length === 0) {
        unit.sourceRefs = ['PDD.md#overview', 'ROADMAP.md#milestones', 'ARCH.md#architecture', 'CONTRACT-TESTS.md#cases', 'DOD.md#checklist'];
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

Validate for:
1. Security risks (file access, network calls, code execution)
2. Resource costs (estimated tokens, time, API calls)
3. Capability requirements (are required capabilities available?)
4. Fallback strategy (what if a unit fails?)

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
Required capabilities must exist in capability matrix
No unapproved file system access`,
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
      sourceRefs: ['SCAFFOLD.md#structure', 'ARCH.md#module-structure']
    });

    addUnit({
      id: 'contract-tests-from-pdd',
      description: 'Generate contract tests from PDD acceptance criteria and map each test to acceptance IDs before feature implementation.',
      requiredPersona: 'specialist-qa',
      dependencies: ['scaffold-bootstrap'],
      estimatedComplexity: 'medium',
      requiredCapabilities: ['testing', 'validation'],
      sourceRefs: ['PDD.md#success-criteria', 'CONTRACT-TESTS.md#cases']
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
      requiredPersona: 'specialist-qa',
      dependencies: implUnitIds,
      estimatedComplexity: 'low',
      requiredCapabilities: ['validation', 'auditing'],
      sourceRefs: ['DOD.md#checklist', 'PDD.md#success-criteria']
    });

    addUnit({
      id: 'gate-golden-benchmark-suite',
      description: 'Run golden benchmark suite for major changes using GOLDEN-BENCHMARKS.md and report command outputs, timing, and pass/fail.',
      requiredPersona: 'specialist-qa',
      dependencies: ['gate-definition-of-done'],
      estimatedComplexity: 'medium',
      requiredCapabilities: ['testing', 'validation'],
      sourceRefs: ['GOLDEN-BENCHMARKS.md#suite', 'ROADMAP.md#critical-path']
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
