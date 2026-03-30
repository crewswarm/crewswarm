/**
 * Unit tests for lib/domain-planning/detector.mjs
 *
 * Tests the exported functions: DOMAINS, detectDomain, buildDomainContext,
 * logDomainRouting. All are pure functions with no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOMAINS, detectDomain, buildDomainContext, logDomainRouting } from "../../lib/domain-planning/detector.mjs";

describe("DOMAINS constant", () => {
  it("defines all expected domain IDs", () => {
    const expected = ["crew-cli", "frontend", "core", "integrations", "docs"];
    for (const id of expected) {
      assert.ok(DOMAINS[id], `Missing domain: ${id}`);
    }
  });

  it("each domain has pmAgent, keywords array, description, and subdirs", () => {
    for (const [id, domain] of Object.entries(DOMAINS)) {
      assert.ok(typeof domain.pmAgent === "string", `${id} missing pmAgent`);
      assert.ok(Array.isArray(domain.keywords), `${id} missing keywords`);
      assert.ok(domain.keywords.length > 0, `${id} has empty keywords`);
      assert.ok(typeof domain.description === "string", `${id} missing description`);
      assert.ok(Array.isArray(domain.subdirs), `${id} missing subdirs`);
    }
  });
});

describe("detectDomain", () => {
  it("detects crew-cli domain for CLI-related text", () => {
    const result = detectDomain("Add a new CLI command for crew exec in crew-cli/src/");
    assert.equal(result.domain, "crew-cli");
    assert.equal(result.pmAgent, "crew-pm-cli");
    assert.ok(result.confidence > 0);
  });

  it("detects frontend domain for dashboard text", () => {
    const result = detectDomain("Update the dashboard UI and fix the agents tab CSS styles");
    assert.equal(result.domain, "frontend");
    assert.equal(result.pmAgent, "crew-pm-frontend");
  });

  it("detects core domain for orchestration text", () => {
    const result = detectDomain("Fix the gateway-bridge WebSocket dispatch and crew-lead coordination");
    assert.equal(result.domain, "core");
    assert.equal(result.pmAgent, "crew-pm-core");
  });

  it("detects integrations domain for Telegram/WhatsApp text", () => {
    const result = detectDomain("Fix the Telegram bridge bot integration with WhatsApp");
    assert.equal(result.domain, "integrations");
    assert.equal(result.pmAgent, "crew-pm");
  });

  it("detects docs domain for documentation text", () => {
    const result = detectDomain("Update the documentation README and add a tutorial guide in docs/");
    assert.equal(result.domain, "docs");
    assert.equal(result.pmAgent, "crew-pm");
  });

  it("returns null domain and default PM for ambiguous text", () => {
    const result = detectDomain("improve performance");
    assert.equal(result.domain, null);
    assert.equal(result.pmAgent, "crew-pm");
    assert.equal(result.confidence, 0);
  });

  it("returns null domain for empty text", () => {
    const result = detectDomain("");
    assert.equal(result.domain, null);
    assert.equal(result.confidence, 0);
  });

  it("confidence is between 0 and 1", () => {
    const result = detectDomain("Add a CLI command for crew exec in crew-cli/src/ with TypeScript pipeline");
    assert.ok(result.confidence >= 0);
    assert.ok(result.confidence <= 1);
  });

  it("longer keywords score higher weight", () => {
    // "session manager" (15 chars) should score 3 points vs "src/" (4 chars) at 1 point
    const result = detectDomain("session manager orchestrator pipeline");
    assert.equal(result.domain, "crew-cli");
  });

  it("is case-insensitive", () => {
    const lower = detectDomain("update the dashboard frontend ui");
    const upper = detectDomain("UPDATE THE DASHBOARD FRONTEND UI");
    assert.equal(lower.domain, upper.domain);
    assert.equal(lower.confidence, upper.confidence);
  });
});

describe("buildDomainContext", () => {
  it("returns empty string for null domain", () => {
    assert.equal(buildDomainContext(null, "some task"), "");
  });

  it("returns empty string for unknown domain", () => {
    assert.equal(buildDomainContext("nonexistent", "some task"), "");
  });

  it("includes domain description and subdirs for crew-cli", () => {
    const ctx = buildDomainContext("crew-cli", "Add new command");
    assert.ok(ctx.includes("crew-cli"));
    assert.ok(ctx.includes("Domain:"));
    assert.ok(ctx.includes("crew-cli/src"));
  });

  it("includes domain-specific guidance for frontend", () => {
    const ctx = buildDomainContext("frontend", "Fix CSS");
    assert.ok(ctx.includes("frontend"));
    assert.ok(ctx.includes("Vite") || ctx.includes("dashboard"));
  });

  it("includes domain-specific guidance for core", () => {
    const ctx = buildDomainContext("core", "Fix dispatch");
    assert.ok(ctx.includes("Gateway-bridge") || ctx.includes("orchestration") || ctx.includes("lib/"));
  });

  it("includes domain-specific guidance for integrations", () => {
    const ctx = buildDomainContext("integrations", "Fix Telegram");
    assert.ok(ctx.includes("bridge") || ctx.includes("integration"));
  });

  it("includes domain-specific guidance for docs", () => {
    const ctx = buildDomainContext("docs", "Update README");
    assert.ok(ctx.includes("Markdown") || ctx.includes("docs"));
  });

  it("all valid domains produce non-empty context", () => {
    for (const id of Object.keys(DOMAINS)) {
      const ctx = buildDomainContext(id, "test task");
      assert.ok(ctx.length > 0, `Empty context for domain: ${id}`);
    }
  });
});

describe("logDomainRouting", () => {
  it("does not throw for matched domain", () => {
    assert.doesNotThrow(() => {
      logDomainRouting("CLI task", { domain: "crew-cli", pmAgent: "crew-pm-cli", confidence: 0.8 });
    });
  });

  it("does not throw for unmatched domain", () => {
    assert.doesNotThrow(() => {
      logDomainRouting("vague task", { domain: null, pmAgent: "crew-pm", confidence: 0 });
    });
  });
});
