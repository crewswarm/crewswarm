/**
 * Unit tests for lib/crew-lead/prompts.mjs
 * Tests: initPrompts, buildSystemPrompt (memoization, custom prompts, agentRoster,
 * agentModels, getAgentRole static/dynamic/fallback, key-based cache invalidation).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  initPrompts,
  buildSystemPrompt,
} from "../../lib/crew-lead/prompts.mjs";

// ── Minimal valid cfg ──────────────────────────────────────────────────────
// Always generates a unique modelId to bust the module-level memo cache so
// tests in the same process are fully isolated.
function baseCfg(overrides = {}) {
  return {
    providerKey: "groq",
    modelId: uniqModelId(),
    displayName: "TestLead",
    emoji: "🤖",
    knownAgents: [],
    agentRoster: [],
    agentModels: {},
    ...overrides,
  };
}

// Counter used to generate unique modelIds across tests, busting the memo cache.
// The cache key is providerKey|modelId|displayName|fileMtimes, so a unique modelId
// guarantees a cache miss even across test suites in the same process.
let _uniqSeq = 0;
function uniqModelId() {
  return `test-model-${++_uniqSeq}`;
}

// Reset module-level mutable state before each test so cache from one test
// does not bleed into the next.
function resetPromptModule() {
  // Re-init with a tryRead that always fails (avoids live FS reads) and
  // a fresh getAgentPrompts returning empty object.
  initPrompts({
    crewswarmCfgFile: "/nonexistent/crewswarm.json",
    historyDir: "/nonexistent/history",
    getAgentPrompts: () => ({}),
    tryRead: () => null,
    maxDynamicAgents: 5,
  });
}

describe("prompts — initPrompts", () => {
  beforeEach(resetPromptModule);

  it("accepts partial overrides without throwing", () => {
    assert.doesNotThrow(() => {
      initPrompts({ maxDynamicAgents: 10 });
    });
  });

  it("accepts empty options object without throwing", () => {
    assert.doesNotThrow(() => {
      initPrompts({});
    });
  });

  it("accepts undefined without throwing", () => {
    assert.doesNotThrow(() => {
      initPrompts();
    });
  });
});

describe("prompts — buildSystemPrompt basics", () => {
  beforeEach(resetPromptModule);

  it("returns a non-empty string", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(typeof prompt === "string");
    assert.ok(prompt.length > 100);
  });

  it("embeds providerKey and modelId in the intro", () => {
    const prompt = buildSystemPrompt(
      baseCfg({ providerKey: "openai", modelId: "gpt-5.4" }),
    );
    assert.ok(prompt.includes("openai/gpt-5.4"), "model string not found in prompt");
  });

  it("embeds displayName in the intro", () => {
    const prompt = buildSystemPrompt(baseCfg({ displayName: "Commander" }));
    assert.ok(prompt.includes("Commander"));
  });

  it("embeds emoji in the intro", () => {
    const prompt = buildSystemPrompt(baseCfg({ emoji: "🦾" }));
    assert.ok(prompt.includes("🦾"));
  });

  it("includes standard section headers", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("§ 0"), "§ 0 OPERATING PRINCIPLES missing");
    assert.ok(prompt.includes("§ 1"), "§ 1 missing");
    assert.ok(prompt.includes("§ 2"), "§ 2 TOOL SYNTAX missing");
    assert.ok(prompt.includes("§ 9"), "§ 9 STYLE missing");
  });

  it("includes @@DISPATCH syntax in tool section", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("@@DISPATCH"), "@@DISPATCH not in prompt");
  });

  it("includes @@PIPELINE syntax in prompt", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("@@PIPELINE"), "@@PIPELINE not in prompt");
  });
});

describe("prompts — memoization", () => {
  beforeEach(resetPromptModule);

  it("returns the same reference when cfg key is unchanged", () => {
    // Use a fixed modelId so both calls share the same cache key
    const fixedId = uniqModelId();
    const cfg = { providerKey: "groq", modelId: fixedId, displayName: "TestLead", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} };
    const first = buildSystemPrompt(cfg);
    const second = buildSystemPrompt(cfg);
    assert.strictEqual(first, second, "cache miss on identical config");
  });

  it("rebuilds prompt when providerKey changes", () => {
    const fixedId = uniqModelId();
    const first = buildSystemPrompt({ providerKey: "groq", modelId: fixedId, displayName: "L", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    const second = buildSystemPrompt({ providerKey: "openai", modelId: fixedId, displayName: "L", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    assert.notEqual(first, second, "cache wrongly hit on different providerKey");
  });

  it("rebuilds prompt when modelId changes", () => {
    const first = buildSystemPrompt({ providerKey: "groq", modelId: "memo-test-a", displayName: "L", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    const second = buildSystemPrompt({ providerKey: "groq", modelId: "memo-test-b", displayName: "L", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    assert.notEqual(first, second, "cache wrongly hit on different modelId");
  });

  it("rebuilds prompt when displayName changes", () => {
    const fixedId = uniqModelId();
    const first = buildSystemPrompt({ providerKey: "groq", modelId: fixedId, displayName: "Alpha", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    const second = buildSystemPrompt({ providerKey: "groq", modelId: fixedId, displayName: "Beta", emoji: "🤖", knownAgents: [], agentRoster: [], agentModels: {} });
    assert.notEqual(first, second);
  });
});

describe("prompts — agentRoster rendering", () => {
  beforeEach(resetPromptModule);

  it("uses knownAgents when agentRoster is empty", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [],
        knownAgents: ["crew-coder", "crew-qa"],
      }),
    );
    assert.ok(prompt.includes("crew-coder"));
    assert.ok(prompt.includes("crew-qa"));
  });

  it("prefers agentRoster over knownAgents — agentRoster member is listed", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [
          { id: "crew-coder", name: "Coder", emoji: "💻", model: "groq/llama" },
        ],
        knownAgents: ["crew-totally-unique-not-in-roster-xyz"],
      }),
    );
    // agentRoster member appears (in the agent list section)
    assert.ok(prompt.includes("crew-coder"), "agentRoster member not found");
    // The unique knownAgent string should NOT appear (since agentRoster is used instead)
    assert.ok(
      !prompt.includes("crew-totally-unique-not-in-roster-xyz"),
      "knownAgents entry should not appear when agentRoster is non-empty",
    );
  });

  it("includes agent model in brackets when provided", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [
          { id: "crew-coder", name: "Coder", emoji: "💻", model: "openai/gpt-5.4" },
        ],
      }),
    );
    assert.ok(prompt.includes("[openai/gpt-5.4]"));
  });

  it("renders role from static _FUNCTIONAL_ROLES_STATIC for crew-coder", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [
          { id: "crew-coder", name: "Coder" },
        ],
      }),
    );
    assert.ok(
      prompt.includes("general coding"),
      "Expected static role for crew-coder",
    );
  });

  it("renders role from static map for crew-qa", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [{ id: "crew-qa", name: "QA" }],
      }),
    );
    assert.ok(prompt.includes("testing"));
  });

  it("falls back to 'general agent' for unknown id with no config", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [{ id: "crew-unknown-xyz", name: "Unknown" }],
      }),
    );
    assert.ok(prompt.includes("general agent"));
  });

  it("uses identity.theme as role for dynamic agent when available", () => {
    initPrompts({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return {
            agents: [
              {
                id: "crew-custom",
                identity: { theme: "custom theme role" },
              },
            ],
          };
        }
        return null;
      },
    });
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [{ id: "crew-custom", name: "Custom" }],
      }),
    );
    assert.ok(prompt.includes("custom theme role"));
  });

  it("uses _role description for dynamic agent with recognized _role", () => {
    initPrompts({
      tryRead: (p) => {
        if (p.endsWith("crewswarm.json")) {
          return {
            agents: [{ id: "crew-ml", _role: "coder" }],
          };
        }
        return null;
      },
    });
    const prompt = buildSystemPrompt(
      baseCfg({
        agentRoster: [{ id: "crew-ml", name: "MLBot" }],
      }),
    );
    assert.ok(prompt.includes("coding, implementation"));
  });
});

describe("prompts — agentModels section", () => {
  beforeEach(resetPromptModule);

  it("includes model list header when agentModels is populated", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        providerKey: "openai",
        modelId: "gpt-5.4",
        agentModels: {
          "crew-lead": "openai/gpt-5.4",
          "crew-coder": "groq/llama-3.1-70b",
        },
      }),
    );
    assert.ok(prompt.includes("YOUR model (crew-lead)"));
    assert.ok(prompt.includes("crew-coder: groq/llama-3.1-70b"));
  });

  it("excludes crew-lead from the 'other agents' list", () => {
    const prompt = buildSystemPrompt(
      baseCfg({
        agentModels: {
          "crew-lead": "openai/gpt-5.4",
          "crew-qa": "groq/llama",
        },
      }),
    );
    // crew-lead should appear once in the YOUR model line only
    const idx = prompt.indexOf("crew-lead: openai/gpt-5.4");
    // The "other agents" block should not list crew-lead → -1
    assert.equal(idx, -1, "crew-lead must not appear in other-agents list");
  });

  it("omits model list when agentModels is empty", () => {
    const prompt = buildSystemPrompt(baseCfg({ agentModels: {} }));
    assert.ok(!prompt.includes("YOUR model (crew-lead)"));
  });
});

describe("prompts — custom prompt injection", () => {
  beforeEach(resetPromptModule);

  it("injects custom prompt when getAgentPrompts returns crew-lead entry", () => {
    initPrompts({
      getAgentPrompts: () => ({ "crew-lead": "CUSTOM RULE: always be helpful" }),
      tryRead: () => null,
    });
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("CUSTOM RULE: always be helpful"));
  });

  it("still includes identity line with custom prompt", () => {
    initPrompts({
      getAgentPrompts: () => ({ "crew-lead": "custom instructions" }),
      tryRead: () => null,
    });
    const prompt = buildSystemPrompt(
      baseCfg({ providerKey: "groq", modelId: "llama-3.1-8b-instant", displayName: "Lead" }),
    );
    assert.ok(prompt.includes("crew-lead"), "identity line missing");
    assert.ok(prompt.includes("groq/llama-3.1-8b-instant"));
  });

  it("does not include custom prompt section when not set", () => {
    initPrompts({
      getAgentPrompts: () => ({}),
      tryRead: () => null,
    });
    const prompt = buildSystemPrompt(baseCfg());
    // Default intro should include "conversational assistant"
    assert.ok(prompt.includes("conversational assistant"));
  });

  it("trims whitespace from custom prompt", () => {
    initPrompts({
      getAgentPrompts: () => ({ "crew-lead": "   trimmed rule   " }),
      tryRead: () => null,
    });
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("trimmed rule"));
  });
});

describe("prompts — maxDynamicAgents in prompt", () => {
  beforeEach(resetPromptModule);

  it("reflects maxDynamicAgents value in agent management section", () => {
    initPrompts({ maxDynamicAgents: 12, tryRead: () => null });
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("12"), "maxDynamicAgents not reflected");
  });

  it("defaults to 5 when not overridden", () => {
    initPrompts({ tryRead: () => null });
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("5"));
  });
});

describe("prompts — shared chat overlay", () => {
  beforeEach(resetPromptModule);

  it("includes Shared Chat section from overlay", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("Shared Chat"), "shared chat overlay missing");
  });

  it("includes @@DISPATCH note in overlay section", () => {
    const prompt = buildSystemPrompt(baseCfg());
    assert.ok(prompt.includes("@@DISPATCH"));
  });
});
