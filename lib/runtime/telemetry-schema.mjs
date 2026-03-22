/**
 * lib/runtime/telemetry-schema.mjs
 *
 * Canonical JSON Schema definitions for crewswarm telemetry events.
 * Matches docs/OPS-TELEMETRY-SCHEMA.md.
 *
 * Exported:
 *   TELEMETRY_SCHEMAS       — { [eventType]: schema }
 *   ENVELOPE_REQUIRED       — required envelope fields (all event types)
 *   validateTelemetryEvent  — validate a parsed event object, returns { ok, errors }
 *   validateTelemetryLog    — validate all lines in a JSONL file, returns summary
 */

import fs from "node:fs";

// ── Envelope fields shared by all event types ────────────────────────────────

const ENVELOPE_REQUIRED = ["schemaVersion", "eventType", "eventId", "occurredAt", "source", "correlationId", "data"];

const ENVELOPE_SCHEMA = {
  type: "object",
  required: ENVELOPE_REQUIRED,
  properties: {
    schemaVersion: { type: "string", pattern: "^\\d+\\.\\d+$" },
    eventType:     { type: "string", minLength: 1 },
    eventId:       { type: "string", minLength: 1 },
    occurredAt:    { type: "string", format: "date-time-ish" },
    receivedAt:    { type: "string" },
    source: {
      type: "object",
      required: ["component"],
      properties: {
        component: { type: "string", minLength: 1 },
        agentId:   { type: "string" },
        hostname:  { type: "string" },
        pid:       { type: "number" },
      },
    },
    correlationId: { type: "string", minLength: 1 },
    sessionId:     { type: "string" },
    initiator:     { type: "object" },
    tags:          { type: "object" },
    data:          { type: "object" },
  },
};

// ── Event-type data schemas ───────────────────────────────────────────────────

const AGENT_PRESENCE_DATA_SCHEMA = {
  type: "object",
  required: ["status", "latencyMs", "uptimeSeconds", "heartbeatSeq", "version"],
  properties: {
    status:         { type: "string", enum: ["online", "offline", "degraded", "draining"] },
    latencyMs:      { type: "number", minimum: 0 },
    uptimeSeconds:  { type: "number", minimum: 0 },
    queueDepth:     { type: "number", minimum: 0 },
    lastTaskId:     { type: "string" },
    heartbeatSeq:   { type: "number", minimum: 0 },
    capabilities:   { type: "array", items: { type: "string" } },
    version:        { type: "string", minLength: 1 },
  },
};

const TASK_LIFECYCLE_DATA_SCHEMA = {
  type: "object",
  required: ["taskId", "agentId", "taskType", "phase", "phaseOrdinal"],
  properties: {
    taskId:       { type: "string", minLength: 1 },
    agentId:      { type: "string", minLength: 1 },
    taskType:     { type: "string", minLength: 1 },
    phase:        {
      type: "string",
      enum: ["dispatched","accepted","started","needs_approval","approved","rejected","awaiting_input","completed","failed","escalated","cancelled"],
    },
    phaseOrdinal: { type: "number", minimum: 0 },
    durationMs:   { type: "number", minimum: 0 },
    result:       { type: "object" },
    error:        { type: "object" },
    retryStrategy:{ type: "object" },
    dispatcher:   { type: "object" },
  },
};

const ERROR_DATA_SCHEMA = {
  type: "object",
  required: ["component", "severity", "errorCode", "message"],
  properties: {
    component: { type: "string", minLength: 1 },
    severity:  { type: "string", enum: ["info", "warn", "error", "critical"] },
    errorCode: { type: "string", minLength: 1 },
    message:   { type: "string", minLength: 1 },
    stack:     { type: "string" },
    taskId:    { type: "string" },
    agentId:   { type: "string" },
    context:   { type: "object" },
  },
};

// ── Exported schemas map ──────────────────────────────────────────────────────

export const TELEMETRY_SCHEMAS = {
  "agent.presence":  { envelope: ENVELOPE_SCHEMA, data: AGENT_PRESENCE_DATA_SCHEMA },
  "task.lifecycle":  { envelope: ENVELOPE_SCHEMA, data: TASK_LIFECYCLE_DATA_SCHEMA },
  "error":           { envelope: ENVELOPE_SCHEMA, data: ERROR_DATA_SCHEMA },
};

// ── Lightweight schema validator (no dependencies) ────────────────────────────

function validateValue(value, schema, path) {
  const errors = [];
  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== schema.type) {
      errors.push(`${path}: expected ${schema.type}, got ${actualType}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: "${value}" not in allowed values [${schema.enum.join(", ")}]`);
  }
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}: string length ${value.length} < minimum ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
  }
  if (schema.type === "object" && schema.required) {
    for (const key of schema.required) {
      if (value[key] === undefined || value[key] === null) {
        errors.push(`${path}.${key}: required field missing`);
      }
    }
  }
  if (schema.type === "object" && schema.properties && typeof value === "object") {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (value[key] !== undefined && value[key] !== null) {
        errors.push(...validateValue(value[key], propSchema, `${path}.${key}`));
      }
    }
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => {
      errors.push(...validateValue(item, schema.items, `${path}[${i}]`));
    });
  }
  return errors;
}

/**
 * Validate a single parsed telemetry event object.
 * @param {object} event  — parsed JSON event
 * @returns {{ ok: boolean, errors: string[], eventType: string }}
 */
export function validateTelemetryEvent(event) {
  if (!event || typeof event !== "object") {
    return { ok: false, errors: ["event is not an object"], eventType: "unknown" };
  }
  const eventType = event.eventType || "unknown";
  const errors = [];

  // Envelope validation (common to all types)
  errors.push(...validateValue(event, ENVELOPE_SCHEMA, "event"));

  // Data validation (type-specific)
  const typeSchema = TELEMETRY_SCHEMAS[eventType];
  if (typeSchema && event.data && typeof event.data === "object") {
    errors.push(...validateValue(event.data, typeSchema.data, "event.data"));
  } else if (!typeSchema) {
    // Unknown event type — only warn, don't fail (forward-compat)
    errors.push(`event.eventType: unknown type "${eventType}" (not in schema — new type or typo)`);
  }

  return { ok: errors.length === 0, errors, eventType };
}

/**
 * Validate all lines in a JSONL telemetry log file.
 * @param {string} filePath
 * @returns {{ total: number, valid: number, invalid: number, unknownType: number, issues: Array }}
 */
export function validateTelemetryLog(filePath) {
  const summary = { total: 0, valid: 0, invalid: 0, unknownType: 0, issues: [] };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return summary;
  }
  for (const line of raw.split("\n").filter(l => l.trim())) {
    summary.total++;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { summary.invalid++; summary.issues.push({ line: summary.total, error: "invalid JSON" }); continue; }
    const result = validateTelemetryEvent(parsed);
    if (!result.ok) {
      const isUnknownType = result.errors.some(e => e.includes("unknown type"));
      if (isUnknownType) summary.unknownType++;
      else summary.invalid++;
      summary.issues.push({ line: summary.total, eventType: result.eventType, errors: result.errors });
    } else {
      summary.valid++;
    }
  }
  return summary;
}
