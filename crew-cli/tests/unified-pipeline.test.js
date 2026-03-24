import { test } from 'node:test';
import assert from 'node:assert';
import { UnifiedPipeline } from '../src/pipeline/unified.ts';

function makePipeline() {
  const pipeline = new UnifiedPipeline();
  pipeline.composer = {
    compose: () => ({ finalPrompt: 'mock-prompt' }),
    getTrace: () => []
  };
  return pipeline;
}

test('UnifiedPipeline routeOnly maps direct-answer to CHAT', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'direct-answer',
    reasoning: 'simple chat',
    directResponse: 'hello',
    traceId: 'trace-1'
  });

  const out = await pipeline.routeOnly({ userInput: 'hi', sessionId: 's1' });
  assert.equal(out.decision, 'CHAT');
  assert.equal(out.response, 'hello');
});

test('UnifiedPipeline routeOnly maps execute-local to CODE', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'execute-local',
    reasoning: 'single task',
    traceId: 'trace-2'
  });

  const out = await pipeline.routeOnly({ userInput: 'write code', sessionId: 's1' });
  assert.equal(out.decision, 'CODE');
  assert.equal(out.agent, 'crew-coder');
});

test('UnifiedPipeline routeOnly maps execute-parallel to DISPATCH', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'execute-parallel',
    reasoning: 'complex task',
    traceId: 'trace-3'
  });

  const out = await pipeline.routeOnly({ userInput: 'build full app', sessionId: 's1' });
  assert.equal(out.decision, 'DISPATCH');
  assert.equal(out.agent, 'crew-main');
});

test('UnifiedPipeline execute direct-answer avoids L3 execution', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'direct-answer',
    reasoning: 'chat',
    directResponse: 'done',
    traceId: 'trace-4'
  });

  const result = await pipeline.execute({ userInput: 'hi', sessionId: 's1' });
  assert.equal(result.response, 'done');
  assert.deepEqual(result.executionPath, ['l1-interface', 'l2-orchestrator', 'l2-direct-response']);
  assert.equal(result.phase, 'complete');
  assert.ok(Array.isArray(result.timeline));
  assert.equal(result.timeline[result.timeline.length - 1].phase, 'complete');
});

test('UnifiedPipeline execute execute-local runs single executor path', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'execute-local',
    reasoning: 'code task',
    traceId: 'trace-5'
  });
  pipeline.l3ExecuteSingle = async () => ({
    workUnitId: 'single',
    persona: 'executor-code',
    output: 'ok',
    cost: 0.02
  });

  const result = await pipeline.execute({ userInput: 'make file', sessionId: 's1' });
  assert.equal(result.response, 'ok');
  assert.equal(result.totalCost, 0.02);
  assert.deepEqual(result.executionPath, ['l1-interface', 'l2-orchestrator', 'l3-executor-single']);
});

test('UnifiedPipeline execute execute-parallel runs batched path', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'execute-parallel',
    reasoning: 'multi task',
    traceId: 'trace-6',
    workGraph: {
      units: [],
      totalComplexity: 1,
      requiredPersonas: [],
      estimatedCost: 0.1
    }
  });
  pipeline.l3ExecuteParallel = async () => ({
    success: true,
    results: [{ workUnitId: 'a', persona: 'crew-coder', output: 'A', cost: 0.01 }],
    totalCost: 0.01,
    executionTimeMs: 10
  });

  const result = await pipeline.execute({ userInput: 'build feature', sessionId: 's1' });
  assert.equal(result.totalCost, 0.01);
  assert.match(result.response, /crew-coder/);
  assert.deepEqual(result.executionPath, ['l1-interface', 'l2-orchestrator', 'l3-executor-parallel']);
});

test('UnifiedPipeline execute falls back when parallel selected without workGraph', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => ({
    decision: 'execute-parallel',
    reasoning: 'parallel requested but missing graph',
    traceId: 'trace-6b'
  });
  pipeline.l3ExecuteSingle = async () => ({
    workUnitId: 'single-fallback',
    persona: 'executor-code',
    output: 'fallback-ok',
    cost: 0.005
  });

  const result = await pipeline.execute({ userInput: 'build feature', sessionId: 's1' });
  assert.equal(result.response, 'fallback-ok');
  // Falls back to either single or direct executor path
  const lastPath = result.executionPath[result.executionPath.length - 1];
  assert.ok(lastPath === 'l3-executor-single' || lastPath === 'l3-executor-direct',
    `Expected l3-executor-single or l3-executor-direct, got ${lastPath}`);
});

test('UnifiedPipeline dependency helpers order and batch correctly', () => {
  const pipeline = makePipeline();
  const units = [
    { id: 'a', description: 'a', requiredPersona: 'crew-coder', dependencies: [], estimatedComplexity: 'low', requiredCapabilities: [] },
    { id: 'b', description: 'b', requiredPersona: 'crew-qa', dependencies: ['a'], estimatedComplexity: 'low', requiredCapabilities: [] },
    { id: 'c', description: 'c', requiredPersona: 'crew-fixer', dependencies: ['a'], estimatedComplexity: 'low', requiredCapabilities: [] }
  ];

  const sorted = pipeline.topologicalSort(units);
  assert.equal(sorted[0].id, 'a');
  const batches = pipeline.getBatches(sorted);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[1].length, 2);
});

test('UnifiedPipeline getTrace returns composer/planner trace payload', () => {
  const pipeline = makePipeline();
  pipeline.planner = { getTrace: () => ({ id: 'p-trace' }) };
  const out = pipeline.getTrace('trace-7');
  assert.ok(Array.isArray(out.composedPrompts));
  assert.deepEqual(out.plannerTrace, { id: 'p-trace' });
});

test('UnifiedPipeline normalizeDecision maps CHAT/CODE/DISPATCH shape', () => {
  const pipeline = makePipeline();
  assert.equal(pipeline.normalizeDecision('CHAT'), 'direct-answer');
  // CODE maps to execute-parallel by default (execute-local requires CREW_ALLOW_EXECUTE_LOCAL=true)
  assert.equal(pipeline.normalizeDecision('CODE'), 'execute-parallel');
  assert.equal(pipeline.normalizeDecision('DISPATCH'), 'execute-parallel');
});

test('UnifiedPipeline l3ExecuteParallel injects artifact refs and dependency outputs', async () => {
  const pipeline = makePipeline();
  const prompts = [];
  let idx = 0;
  pipeline.composer = {
    compose: (_templateId, overlays) => {
      const finalPrompt = overlays.map(o => o.content).join('\n\n');
      prompts.push(finalPrompt);
      return { finalPrompt };
    },
    getTrace: () => []
  };
  pipeline.executor = {
    execute: async () => {
      idx += 1;
      return { success: true, result: `worker-output-${idx}`, costUsd: 0.001 };
    }
  };

  const graph = {
    units: [
      {
        id: 'u1',
        description: 'Implement the primary authentication handler with JWT token validation and session management',
        requiredPersona: 'crew-coder',
        dependencies: [],
        estimatedComplexity: 'low',
        requiredCapabilities: ['code-generation'],
        sourceRefs: ['PDD.md#2.1']
      },
      {
        id: 'u2',
        description: 'Write integration tests for the authentication handler covering token validation edge cases',
        requiredPersona: 'crew-qa',
        dependencies: ['u1'],
        estimatedComplexity: 'low',
        requiredCapabilities: ['testing'],
        sourceRefs: ['ARCH.md#api', 'ROADMAP.md#m1']
      }
    ],
    totalComplexity: 2,
    requiredPersonas: ['crew-coder', 'crew-qa'],
    estimatedCost: 0.1,
    planningArtifacts: {
      pdd: '# PDD\nspec',
      roadmap: '# ROADMAP\ntasks',
      architecture: '# ARCH\ndesign',
      outputDir: '/tmp/artifacts',
      files: {
        pdd: '/tmp/artifacts/PDD.md',
        roadmap: '/tmp/artifacts/ROADMAP.md',
        architecture: '/tmp/artifacts/ARCH.md'
      }
    }
  };

  const out = await pipeline.l3ExecuteParallel(graph, 'base-context', 'trace-z');
  assert.equal(out.success, true);
  assert.equal(out.results.length, 2);
  assert.ok(prompts[0].includes('Context pack id:'));
  assert.ok(prompts[0].includes('Required source refs for this unit: PDD.md#2.1'));
  assert.ok(prompts[1].includes('Output from u1'));
  assert.ok(prompts[1].includes('Required source refs for this unit: ARCH.md#api, ROADMAP.md#m1'));
});

test('UnifiedPipeline execute-local runs QA/fixer loop when enabled', async () => {
  const saved = process.env.CREW_QA_LOOP_ENABLED;
  process.env.CREW_QA_LOOP_ENABLED = 'true';
  try {
    const pipeline = makePipeline();
    pipeline.l2Orchestrate = async () => ({
      decision: 'execute-local',
      reasoning: 'code task',
      traceId: 'trace-q1'
    });
    pipeline.l3ExecuteSingle = async () => ({
      workUnitId: 'single',
      persona: 'executor-code',
      output: 'initial-output',
      cost: 0.02
    });
    pipeline.runQaFixerLoop = async (response) => ({
      response: `${response}\nfixed`,
      addedCost: 0.01,
      approved: true,
      rounds: 1,
      lastSummary: 'ok'
    });

    const result = await pipeline.execute({ userInput: 'make file', sessionId: 's1' });
    assert.equal(result.response, 'initial-output\nfixed');
    assert.equal(result.totalCost, 0.03);
    assert.ok(result.executionPath.includes('l3-qa-approved'));
  } finally {
    if (saved === undefined) delete process.env.CREW_QA_LOOP_ENABLED;
    else process.env.CREW_QA_LOOP_ENABLED = saved;
  }
});

test('UnifiedPipeline resume from execute reuses prior plan and skips L2 orchestrate call', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => {
    throw new Error('l2 should be skipped');
  };
  pipeline.l3ExecuteSingle = async () => ({
    workUnitId: 'single',
    persona: 'executor-code',
    output: 'resumed-exec-output',
    cost: 0.01
  });

  const priorPlan = {
    decision: 'execute-local',
    reasoning: 'prior',
    traceId: 'trace-prev'
  };

  const result = await pipeline.execute({
    userInput: 'continue',
    sessionId: 's1',
    resume: {
      fromPhase: 'execute',
      priorPlan
    }
  });
  assert.equal(result.response, 'resumed-exec-output');
  assert.ok(result.executionPath.includes('resume-plan-loaded'));
});

test('UnifiedPipeline resume from validate uses prior response without rerunning executor', async () => {
  const pipeline = makePipeline();
  pipeline.l2Orchestrate = async () => {
    throw new Error('l2 should be skipped');
  };
  pipeline.l3ExecuteSingle = async () => {
    throw new Error('l3 should be skipped');
  };
  pipeline.runExtraL2Validators = async () => ({ approved: true, summary: 'ok', cost: 0, ran: false });
  pipeline.runDefinitionOfDoneGate = async () => ({ approved: true, summary: 'ok', cost: 0, ran: false });
  pipeline.runGoldenBenchmarkGate = async () => ({ approved: true, summary: 'ok', cost: 0, ran: false });

  const priorPlan = {
    decision: 'execute-parallel',
    reasoning: 'prior',
    traceId: 'trace-prev',
    workGraph: {
      units: [],
      totalComplexity: 1,
      requiredPersonas: [],
      estimatedCost: 0.01
    }
  };

  const result = await pipeline.execute({
    userInput: 'continue',
    sessionId: 's1',
    resume: {
      fromPhase: 'validate',
      priorPlan,
      priorResponse: 'prior-validation-input',
      priorExecutionResults: {
        success: true,
        results: [],
        totalCost: 0.01,
        executionTimeMs: 10
      }
    }
  });
  assert.equal(result.response, 'prior-validation-input');
  assert.ok(result.executionPath.includes('resume-validate-only'));
});
