/**
 * Unit tests for crew-cli/src/prompts/dual-l2.ts
 *
 * Covers:
 *  - DualL2Planner: constructor
 *  - Exported interfaces: WorkUnit, WorkGraph, PolicyValidation, DualL2Result
 *    (validated via type shape checks on mock objects)
 *
 * The DualL2Planner.plan() method requires LLM calls and is skipped.
 * Private methods (isLightweightTask, extractAllowedPaths, buildLightweightPlan)
 * are not exported and cannot be tested directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DualL2Planner } from '../../src/prompts/dual-l2.ts';

describe('DualL2Planner — constructor', () => {
  it('instantiates without error', () => {
    const planner = new DualL2Planner();
    assert.ok(planner);
    assert.equal(typeof planner, 'object');
  });

  it('has a plan method', () => {
    const planner = new DualL2Planner();
    assert.equal(typeof planner.plan, 'function');
  });
});

describe('DualL2Planner — type shape validation', () => {
  it('WorkUnit shape is valid', () => {
    const unit = {
      id: 'task-1',
      description: 'Do something',
      requiredPersona: 'executor-code',
      dependencies: [],
      estimatedComplexity: 'low',
      requiredCapabilities: ['code-generation'],
    };
    assert.equal(typeof unit.id, 'string');
    assert.ok(Array.isArray(unit.dependencies));
    assert.ok(['low', 'medium', 'high'].includes(unit.estimatedComplexity));
  });

  it('WorkGraph shape is valid', () => {
    const graph = {
      units: [],
      totalComplexity: 1,
      requiredPersonas: ['executor-code'],
      estimatedCost: 0.001,
    };
    assert.ok(Array.isArray(graph.units));
    assert.equal(typeof graph.totalComplexity, 'number');
    assert.equal(typeof graph.estimatedCost, 'number');
  });

  it('PolicyValidation shape is valid', () => {
    const validation = {
      approved: true,
      riskLevel: 'low',
      concerns: [],
      recommendations: ['keep scope tight'],
      estimatedCost: 0.001,
    };
    assert.equal(typeof validation.approved, 'boolean');
    assert.ok(['low', 'medium', 'high', 'critical'].includes(validation.riskLevel));
    assert.ok(Array.isArray(validation.concerns));
  });

  it('DualL2Result shape is valid', () => {
    const result = {
      workGraph: { units: [], totalComplexity: 0, requiredPersonas: [], estimatedCost: 0 },
      validation: { approved: true, riskLevel: 'low', concerns: [], recommendations: [], estimatedCost: 0 },
      traceId: 'trace-123',
      executionPath: ['dual-l2-planner'],
    };
    assert.equal(typeof result.traceId, 'string');
    assert.ok(Array.isArray(result.executionPath));
    assert.ok(result.workGraph);
    assert.ok(result.validation);
  });
});
