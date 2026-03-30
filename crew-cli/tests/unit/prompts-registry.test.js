/**
 * Unit tests for crew-cli/src/prompts/registry.ts
 *
 * Tests exported constants and functions: PROMPT_TEMPLATES, PERSONA_PROFILES,
 * CAPABILITY_MATRIX, PromptComposer, hasCapability, getRiskLevel, getTemplateForPersona.
 *
 * All pure functions — no mocking needed.
 *
 * Run with: node --import tsx --test crew-cli/tests/unit/prompts-registry.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_TEMPLATES,
  PERSONA_PROFILES,
  CAPABILITY_MATRIX,
  PromptComposer,
  hasCapability,
  getRiskLevel,
  getTemplateForPersona,
} from '../../src/prompts/registry.js';

// ---------------------------------------------------------------------------
// PROMPT_TEMPLATES
// ---------------------------------------------------------------------------

describe('PROMPT_TEMPLATES', () => {
  it('is a non-empty object', () => {
    assert.ok(Object.keys(PROMPT_TEMPLATES).length > 0);
  });

  it('contains the router-v1 template', () => {
    const t = PROMPT_TEMPLATES['router-v1'];
    assert.ok(t, 'router-v1 should exist');
    assert.equal(t.id, 'router-v1');
    assert.equal(t.riskLevel, 'low');
    assert.ok(t.basePrompt.length > 0);
  });

  it('contains executor-code-v1 template with code standards', () => {
    const t = PROMPT_TEMPLATES['executor-code-v1'];
    assert.ok(t, 'executor-code-v1 should exist');
    assert.ok(t.basePrompt.includes('@@WRITE_FILE'));
    assert.ok(t.allowedOverlays.includes('task'));
    assert.ok(t.allowedOverlays.includes('safety'));
  });

  it('every template has required fields', () => {
    for (const [key, tmpl] of Object.entries(PROMPT_TEMPLATES)) {
      assert.ok(tmpl.id, `${key} must have id`);
      assert.ok(tmpl.version, `${key} must have version`);
      assert.ok(tmpl.role, `${key} must have role`);
      assert.ok(tmpl.basePrompt, `${key} must have basePrompt`);
      assert.ok(Array.isArray(tmpl.allowedOverlays), `${key} must have allowedOverlays array`);
      assert.ok(Array.isArray(tmpl.capabilities), `${key} must have capabilities array`);
      assert.ok(['low', 'medium', 'high'].includes(tmpl.riskLevel), `${key} riskLevel must be low/medium/high`);
    }
  });
});

// ---------------------------------------------------------------------------
// PERSONA_PROFILES
// ---------------------------------------------------------------------------

describe('PERSONA_PROFILES', () => {
  it('is a non-empty object', () => {
    assert.ok(Object.keys(PERSONA_PROFILES).length > 0);
  });

  const expectedPersonas = [
    'crew-coder', 'crew-qa', 'crew-fixer', 'crew-pm',
    'crew-security', 'crew-main', 'crew-frontend',
  ];

  for (const persona of expectedPersonas) {
    it(`contains ${persona}`, () => {
      const p = PERSONA_PROFILES[persona];
      assert.ok(p, `${persona} should exist`);
      assert.equal(p.id, persona);
      assert.ok(p.templateId, `${persona} must have templateId`);
      assert.ok(Array.isArray(p.capabilities));
      assert.ok(['low', 'medium', 'high'].includes(p.riskLevel));
    });
  }

  it('every persona references a valid template', () => {
    for (const [key, profile] of Object.entries(PERSONA_PROFILES)) {
      assert.ok(
        PROMPT_TEMPLATES[profile.templateId],
        `${key} references templateId "${profile.templateId}" which does not exist in PROMPT_TEMPLATES`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY_MATRIX
// ---------------------------------------------------------------------------

describe('CAPABILITY_MATRIX', () => {
  it('defines capabilities for executor-code', () => {
    const caps = CAPABILITY_MATRIX['executor-code'];
    assert.ok(Array.isArray(caps));
    assert.ok(caps.includes('code-generation'));
    assert.ok(caps.includes('refactoring'));
  });

  it('defines capabilities for specialist-qa', () => {
    const caps = CAPABILITY_MATRIX['specialist-qa'];
    assert.ok(Array.isArray(caps));
    assert.ok(caps.includes('testing'));
  });

  it('defines capabilities for router', () => {
    const caps = CAPABILITY_MATRIX['router'];
    assert.ok(Array.isArray(caps));
    assert.ok(caps.includes('routing'));
  });
});

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe('hasCapability', () => {
  it('returns true for a known capability', () => {
    assert.equal(hasCapability('executor-code', 'code-generation'), true);
  });

  it('returns false for an unknown capability', () => {
    assert.equal(hasCapability('executor-code', 'flying'), false);
  });

  it('returns false for a non-existent template', () => {
    assert.equal(hasCapability('nonexistent', 'code-generation'), false);
  });

  it('strips version suffix when looking up capabilities', () => {
    // 'executor-code-v1' should normalize to 'executor-code' for matrix lookup
    assert.equal(hasCapability('executor-code-v1', 'code-generation'), true);
  });

  it('handles empty/null input gracefully', () => {
    assert.equal(hasCapability('', 'anything'), false);
    assert.equal(hasCapability(null, 'anything'), false);
  });
});

// ---------------------------------------------------------------------------
// getRiskLevel
// ---------------------------------------------------------------------------

describe('getRiskLevel', () => {
  it('returns low for router-v1', () => {
    assert.equal(getRiskLevel('router-v1'), 'low');
  });

  it('returns medium for executor-code-v1', () => {
    assert.equal(getRiskLevel('executor-code-v1'), 'medium');
  });

  it('returns unknown for non-existent template', () => {
    assert.equal(getRiskLevel('does-not-exist'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// getTemplateForPersona
// ---------------------------------------------------------------------------

describe('getTemplateForPersona', () => {
  it('returns executor-code-v1 for crew-coder', () => {
    assert.equal(getTemplateForPersona('crew-coder'), 'executor-code-v1');
  });

  it('returns specialist-qa-v1 for crew-qa', () => {
    assert.equal(getTemplateForPersona('crew-qa'), 'specialist-qa-v1');
  });

  it('returns specialist-pm-v1 for crew-pm', () => {
    assert.equal(getTemplateForPersona('crew-pm'), 'specialist-pm-v1');
  });

  it('returns specialist-qa-v1 for specialist-qa directly', () => {
    assert.equal(getTemplateForPersona('specialist-qa'), 'specialist-qa-v1');
  });

  it('returns executor-chat-v1 for unknown specialist-* personas', () => {
    assert.equal(getTemplateForPersona('specialist-unknown'), 'executor-chat-v1');
  });

  it('returns executor-code-v1 for completely unknown personas', () => {
    assert.equal(getTemplateForPersona('random-agent'), 'executor-code-v1');
  });

  it('handles empty/null input', () => {
    assert.equal(getTemplateForPersona(''), 'executor-code-v1');
    assert.equal(getTemplateForPersona(null), 'executor-code-v1');
  });
});

// ---------------------------------------------------------------------------
// PromptComposer
// ---------------------------------------------------------------------------

describe('PromptComposer', () => {
  let composer;

  beforeEach(() => {
    composer = new PromptComposer();
  });

  describe('getTemplate', () => {
    it('returns a template by ID', () => {
      const t = composer.getTemplate('router-v1');
      assert.ok(t);
      assert.equal(t.id, 'router-v1');
    });

    it('returns undefined for unknown template', () => {
      assert.equal(composer.getTemplate('nope'), undefined);
    });
  });

  describe('compose', () => {
    it('composes a prompt with no overlays', () => {
      const result = composer.compose('router-v1', [], 'trace-1');
      assert.ok(result.finalPrompt.length > 0);
      assert.equal(result.templateId, 'router-v1');
      assert.equal(result.traceId, 'trace-1');
      assert.ok(result.composedAt);
    });

    it('appends overlays in priority order', () => {
      const overlays = [
        { type: 'context', content: 'Context info', priority: 2 },
        { type: 'task', content: 'Task details', priority: 1 },
      ];
      const result = composer.compose('router-v1', overlays, 'trace-2');
      const taskIdx = result.finalPrompt.indexOf('[TASK]');
      const ctxIdx = result.finalPrompt.indexOf('[CONTEXT]');
      assert.ok(taskIdx > -1, 'TASK overlay should appear');
      assert.ok(ctxIdx > -1, 'CONTEXT overlay should appear');
      assert.ok(taskIdx < ctxIdx, 'TASK (priority 1) should come before CONTEXT (priority 2)');
    });

    it('throws for unknown template ID', () => {
      assert.throws(
        () => composer.compose('nonexistent', [], 'trace-3'),
        /Unknown prompt template/,
      );
    });

    it('throws for disallowed overlay type', () => {
      // router-v1 allows: task, context, constraints — NOT safety
      assert.throws(
        () => composer.compose('router-v1', [{ type: 'safety', content: 'no', priority: 1 }], 'trace-4'),
        /not allowed/,
      );
    });

    it('allows safety overlay on executor-code-v1', () => {
      const result = composer.compose(
        'executor-code-v1',
        [{ type: 'safety', content: 'Be careful', priority: 1 }],
        'trace-5',
      );
      assert.ok(result.finalPrompt.includes('[SAFETY]'));
      assert.ok(result.finalPrompt.includes('Be careful'));
    });
  });

  describe('getTrace / clearTrace', () => {
    it('records compositions in the trace log', () => {
      composer.compose('router-v1', [], 'trace-a');
      composer.compose('executor-chat-v1', [], 'trace-b');
      const all = composer.getTrace();
      assert.equal(all.length, 2);
    });

    it('filters trace by traceId', () => {
      composer.compose('router-v1', [], 'trace-x');
      composer.compose('executor-chat-v1', [], 'trace-y');
      const filtered = composer.getTrace('trace-x');
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].traceId, 'trace-x');
    });

    it('clearTrace empties the log', () => {
      composer.compose('router-v1', [], 'trace-z');
      assert.equal(composer.getTrace().length, 1);
      composer.clearTrace();
      assert.equal(composer.getTrace().length, 0);
    });
  });
});
