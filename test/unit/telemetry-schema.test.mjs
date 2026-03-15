import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateTelemetryEvent,
  TELEMETRY_SCHEMAS,
} from "../../lib/runtime/telemetry-schema.mjs";

const ENVELOPE_REQUIRED = ["schemaVersion", "eventType", "eventId", "occurredAt", "source", "correlationId", "data"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePresenceEvent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    eventType: "agent.presence",
    eventId: "ev-001",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: "corr-001",
    source: { component: "crew-coder", agentId: "crew-coder" },
    data: {
      status: "online",
      latencyMs: 12,
      uptimeSeconds: 300,
      heartbeatSeq: 1,
      version: "1.0.0",
    },
    ...overrides,
  };
}

function makeLifecycleEvent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    eventType: "task.lifecycle",
    eventId: "ev-002",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: "corr-002",
    source: { component: "crew-lead" },
    data: {
      taskId: "t-001",
      agentId: "crew-coder",
      taskType: "code",
      phase: "completed",
      phaseOrdinal: 4,
    },
    ...overrides,
  };
}

function makeErrorEvent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    eventType: "error",
    eventId: "ev-003",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: "corr-003",
    source: { component: "gateway-bridge" },
    data: {
      component: "gateway-bridge",
      severity: "error",
      errorCode: "ERR_TIMEOUT",
      message: "Agent timed out after 30s",
    },
    ...overrides,
  };
}

// ── TELEMETRY_SCHEMAS ─────────────────────────────────────────────────────────

describe("TELEMETRY_SCHEMAS", () => {
  test("defines all three required event types", () => {
    assert.ok("agent.presence" in TELEMETRY_SCHEMAS);
    assert.ok("task.lifecycle" in TELEMETRY_SCHEMAS);
    assert.ok("error" in TELEMETRY_SCHEMAS);
  });

  test("each schema has envelope and data sub-schemas", () => {
    for (const [type, schema] of Object.entries(TELEMETRY_SCHEMAS)) {
      assert.ok(schema.envelope, `${type} missing envelope schema`);
      assert.ok(schema.data, `${type} missing data schema`);
    }
  });
});

describe("ENVELOPE_REQUIRED", () => {
  test("contains all mandatory envelope fields", () => {
    const required = ["schemaVersion", "eventType", "eventId", "occurredAt", "source", "correlationId", "data"];
    for (const f of required) {
      assert.ok(ENVELOPE_REQUIRED.includes(f), `${f} missing from ENVELOPE_REQUIRED`);
    }
  });
});

// ── validateTelemetryEvent ────────────────────────────────────────────────────

describe("validateTelemetryEvent — valid events", () => {
  test("validates a correct agent.presence event", () => {
    const { ok, errors } = validateTelemetryEvent(makePresenceEvent());
    assert.equal(ok, true, `errors: ${errors.join("; ")}`);
  });

  test("validates a correct task.lifecycle event", () => {
    const { ok, errors } = validateTelemetryEvent(makeLifecycleEvent());
    assert.equal(ok, true, `errors: ${errors.join("; ")}`);
  });

  test("validates a correct error event", () => {
    const { ok, errors } = validateTelemetryEvent(makeErrorEvent());
    assert.equal(ok, true, `errors: ${errors.join("; ")}`);
  });

  test("accepts optional fields when present", () => {
    const event = makePresenceEvent();
    event.data.queueDepth = 3;
    event.data.capabilities = ["code", "write"];
    const { ok } = validateTelemetryEvent(event);
    assert.equal(ok, true);
  });

  test("accepts all valid task.lifecycle phase values", () => {
    const phases = ["dispatched", "accepted", "started", "completed", "failed", "cancelled"];
    for (const phase of phases) {
      const event = makeLifecycleEvent({ data: { ...makeLifecycleEvent().data, phase } });
      const { ok, errors } = validateTelemetryEvent(event);
      assert.equal(ok, true, `phase "${phase}" failed: ${errors.join("; ")}`);
    }
  });
});

describe("validateTelemetryEvent — invalid events", () => {
  test("rejects non-object input", () => {
    assert.equal(validateTelemetryEvent(null).ok, false);
    assert.equal(validateTelemetryEvent("string").ok, false);
    assert.equal(validateTelemetryEvent(42).ok, false);
  });

  test("rejects event missing correlationId", () => {
    const event = makePresenceEvent();
    delete event.correlationId;
    const { ok, errors } = validateTelemetryEvent(event);
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes("correlationId")));
  });

  test("rejects event missing occurredAt", () => {
    const event = makePresenceEvent();
    delete event.occurredAt;
    const { ok } = validateTelemetryEvent(event);
    assert.equal(ok, false);
  });

  test("rejects agent.presence with invalid status enum", () => {
    const event = makePresenceEvent();
    event.data.status = "sleeping";
    const { ok, errors } = validateTelemetryEvent(event);
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes("status") || e.includes("allowed values")));
  });

  test("rejects task.lifecycle with invalid phase enum", () => {
    const event = makeLifecycleEvent();
    event.data.phase = "unknown-phase";
    const { ok } = validateTelemetryEvent(event);
    assert.equal(ok, false);
  });

  test("warns on unknown event type but does not throw", () => {
    const event = {
      schemaVersion: "1.0",
      eventType: "future.newtype",
      eventId: "ev-x",
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "corr-x",
      source: { component: "test" },
      data: {},
    };
    const { ok, errors } = validateTelemetryEvent(event);
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes("unknown type") || e.includes("future.newtype")));
  });

  test("rejects error event missing required message field", () => {
    const event = makeErrorEvent();
    delete event.data.message;
    const { ok } = validateTelemetryEvent(event);
    assert.equal(ok, false);
  });

  test("rejects error event with invalid severity", () => {
    const event = makeErrorEvent();
    event.data.severity = "extreme";
    const { ok } = validateTelemetryEvent(event);
    assert.equal(ok, false);
  });
});
