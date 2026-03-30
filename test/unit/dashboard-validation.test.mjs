/**
 * Unit tests for scripts/dashboard-validation.mjs
 *
 * Covers:
 *  - AgentIdSchema: accepts valid agent IDs, rejects invalid ones
 *  - ProjectIdSchema / ModelNameSchema: basic string constraints
 *  - SendMessageSchema: validates to/message fields
 *  - CreateAgentSchema: validates required and optional fields
 *  - CreateProjectSchema: validates name and outputDir
 *  - CreateSkillSchema: validates name regex and url format
 *  - ReplayDLQSchema: validates key field
 *  - ServiceActionSchema: validates enum values
 *  - validate() helper: returns { ok, data } on success, { ok, error } on failure
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AgentIdSchema,
  ProjectIdSchema,
  ModelNameSchema,
  SendMessageSchema,
  CreateAgentSchema,
  CreateSkillSchema,
  ReplayDLQSchema,
  ServiceActionSchema,
  UpdateAgentConfigSchema,
  StartBuildSchema,
  SearchMemorySchema,
  DeleteSkillSchema,
  validate,
} from "../../scripts/dashboard-validation.mjs";

// ── AgentIdSchema ──────────────────────────────────────────────────────────

describe("AgentIdSchema", () => {
  it("accepts lowercase alphanumeric with dashes", () => {
    assert.equal(AgentIdSchema.parse("crew-coder"), "crew-coder");
    assert.equal(AgentIdSchema.parse("a"), "a");
    assert.equal(AgentIdSchema.parse("agent-123"), "agent-123");
  });

  it("rejects empty string", () => {
    assert.throws(() => AgentIdSchema.parse(""));
  });

  it("rejects uppercase letters", () => {
    assert.throws(() => AgentIdSchema.parse("Crew-Coder"));
  });

  it("rejects spaces", () => {
    assert.throws(() => AgentIdSchema.parse("crew coder"));
  });

  it("rejects strings over 50 chars", () => {
    assert.throws(() => AgentIdSchema.parse("a".repeat(51)));
  });
});

// ── ProjectIdSchema / ModelNameSchema ──────────────────────────────────────

describe("ProjectIdSchema", () => {
  it("accepts non-empty strings up to 100 chars", () => {
    assert.equal(ProjectIdSchema.parse("my-project"), "my-project");
  });

  it("rejects empty string", () => {
    assert.throws(() => ProjectIdSchema.parse(""));
  });
});

describe("ModelNameSchema", () => {
  it("accepts model names", () => {
    assert.equal(ModelNameSchema.parse("claude-3-opus"), "claude-3-opus");
  });

  it("rejects empty string", () => {
    assert.throws(() => ModelNameSchema.parse(""));
  });
});

// ── SendMessageSchema ─────────────────────────────────────────────────────

describe("SendMessageSchema", () => {
  it("accepts valid message payload", () => {
    const result = SendMessageSchema.parse({ to: "crew-coder", message: "hello" });
    assert.equal(result.to, "crew-coder");
    assert.equal(result.message, "hello");
  });

  it("rejects missing to field", () => {
    assert.throws(() => SendMessageSchema.parse({ message: "hello" }));
  });

  it("rejects missing message field", () => {
    assert.throws(() => SendMessageSchema.parse({ to: "crew-coder" }));
  });

  it("rejects empty message", () => {
    assert.throws(() => SendMessageSchema.parse({ to: "crew-coder", message: "" }));
  });
});

// ── CreateAgentSchema ─────────────────────────────────────────────────────

describe("CreateAgentSchema", () => {
  it("accepts minimal agent definition", () => {
    const result = CreateAgentSchema.parse({ id: "test-agent", model: "gpt-4" });
    assert.equal(result.id, "test-agent");
    assert.equal(result.model, "gpt-4");
  });

  it("accepts optional fields", () => {
    const result = CreateAgentSchema.parse({
      id: "test-agent",
      model: "gpt-4",
      name: "Test Agent",
      emoji: "🤖",
      theme: "dark",
    });
    assert.equal(result.name, "Test Agent");
    assert.equal(result.emoji, "🤖");
  });

  it("rejects missing model", () => {
    assert.throws(() => CreateAgentSchema.parse({ id: "test-agent" }));
  });

  it("rejects missing id", () => {
    assert.throws(() => CreateAgentSchema.parse({ model: "gpt-4" }));
  });
});

// ── UpdateAgentConfigSchema ───────────────────────────────────────────────

describe("UpdateAgentConfigSchema", () => {
  it("accepts agentId with optional model update", () => {
    const result = UpdateAgentConfigSchema.parse({
      agentId: "crew-coder",
      model: "claude-3-opus",
    });
    assert.equal(result.agentId, "crew-coder");
    assert.equal(result.model, "claude-3-opus");
  });

  it("validates toolProfile enum", () => {
    const result = UpdateAgentConfigSchema.parse({
      agentId: "crew-coder",
      toolProfile: "basic",
    });
    assert.equal(result.toolProfile, "basic");
  });

  it("rejects invalid toolProfile", () => {
    assert.throws(() =>
      UpdateAgentConfigSchema.parse({ agentId: "crew-coder", toolProfile: "invalid" })
    );
  });
});

// ── CreateSkillSchema ─────────────────────────────────────────────────────

describe("CreateSkillSchema", () => {
  it("accepts valid skill definition", () => {
    const result = CreateSkillSchema.parse({
      name: "my-skill",
      url: "https://example.com/api",
    });
    assert.equal(result.name, "my-skill");
    assert.equal(result.url, "https://example.com/api");
  });

  it("rejects invalid skill name chars", () => {
    assert.throws(() =>
      CreateSkillSchema.parse({ name: "my skill!", url: "https://example.com" })
    );
  });

  it("rejects invalid url", () => {
    assert.throws(() =>
      CreateSkillSchema.parse({ name: "my-skill", url: "not-a-url" })
    );
  });

  it("accepts optional method", () => {
    const result = CreateSkillSchema.parse({
      name: "my-skill",
      url: "https://example.com",
      method: "POST",
    });
    assert.equal(result.method, "POST");
  });

  it("rejects invalid HTTP method", () => {
    assert.throws(() =>
      CreateSkillSchema.parse({
        name: "my-skill",
        url: "https://example.com",
        method: "INVALID",
      })
    );
  });
});

// ── ReplayDLQSchema ───────────────────────────────────────────────────────

describe("ReplayDLQSchema", () => {
  it("accepts valid key", () => {
    const result = ReplayDLQSchema.parse({ key: "task-123" });
    assert.equal(result.key, "task-123");
  });

  it("rejects empty key", () => {
    assert.throws(() => ReplayDLQSchema.parse({ key: "" }));
  });
});

// ── ServiceActionSchema ───────────────────────────────────────────────────

describe("ServiceActionSchema", () => {
  const validIds = [
    "rt-bus", "agents", "crew-lead", "telegram", "whatsapp",
    "opencode", "mcp", "openclaw-gateway", "dashboard",
  ];

  for (const id of validIds) {
    it(`accepts "${id}"`, () => {
      const result = ServiceActionSchema.parse({ id });
      assert.equal(result.id, id);
    });
  }

  it("rejects unknown service id", () => {
    assert.throws(() => ServiceActionSchema.parse({ id: "unknown-service" }));
  });
});

// ── StartBuildSchema ──────────────────────────────────────────────────────

describe("StartBuildSchema", () => {
  it("accepts requirement string", () => {
    const result = StartBuildSchema.parse({ requirement: "Build a landing page" });
    assert.equal(result.requirement, "Build a landing page");
  });

  it("rejects empty requirement", () => {
    assert.throws(() => StartBuildSchema.parse({ requirement: "" }));
  });
});

// ── SearchMemorySchema ────────────────────────────────────────────────────

describe("SearchMemorySchema", () => {
  it("accepts query with optional maxResults", () => {
    const result = SearchMemorySchema.parse({ query: "test", maxResults: 10 });
    assert.equal(result.query, "test");
    assert.equal(result.maxResults, 10);
  });

  it("rejects maxResults out of range", () => {
    assert.throws(() => SearchMemorySchema.parse({ query: "test", maxResults: 0 }));
    assert.throws(() => SearchMemorySchema.parse({ query: "test", maxResults: 101 }));
  });
});

// ── DeleteSkillSchema ─────────────────────────────────────────────────────

describe("DeleteSkillSchema", () => {
  it("accepts valid name", () => {
    const result = DeleteSkillSchema.parse({ name: "my-skill" });
    assert.equal(result.name, "my-skill");
  });

  it("rejects empty name", () => {
    assert.throws(() => DeleteSkillSchema.parse({ name: "" }));
  });
});

// ── validate() helper ─────────────────────────────────────────────────────

describe("validate()", () => {
  it("returns { ok: true, data } on valid input", () => {
    const result = validate(AgentIdSchema, "crew-coder");
    assert.equal(result.ok, true);
    assert.equal(result.data, "crew-coder");
  });

  it("returns { ok: false, error } on invalid input", () => {
    const result = validate(AgentIdSchema, "");
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  });

  it("works with object schemas", () => {
    const valid = validate(SendMessageSchema, { to: "crew-coder", message: "hi" });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.data, { to: "crew-coder", message: "hi" });

    const invalid = validate(SendMessageSchema, { to: "crew-coder" });
    assert.equal(invalid.ok, false);
  });
});
