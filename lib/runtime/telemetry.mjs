/**
 * Telemetry and ops snapshot — extracted from crew-lead.mjs
 */

let _broadcastSSE = () => {};

export function initTelemetry({ broadcastSSE }) {
  if (broadcastSSE) _broadcastSSE = broadcastSSE;
}

export const TELEMETRY_SCHEMA_VERSION = "1.1";
export const TELEMETRY_EVENT_LIMIT = 100;
export const telemetryEvents = [];
export const taskPhaseOrdinal = new Map();

export const OPS_EVENT_LIMIT = 200;
export const OPS_EVENTS = [];
export const OPS_COUNTERS = {
  tasksDispatched: 0,
  tasksCompleted: 0,
  pipelinesStarted: 0,
  pipelinesCompleted: 0,
  webhooksReceived: 0,
  skillsApproved: 0,
  skillsRejected: 0,
};

export function nextPhaseOrdinal(taskId) {
  const n = (taskPhaseOrdinal.get(taskId) || 0) + 1;
  taskPhaseOrdinal.set(taskId, n);
  return n;
}

export function emitTaskLifecycle(phase, data) {
  const { taskId, agentId } = data;
  const eventId = "evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
  const envelope = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventType: "task.lifecycle",
    eventId,
    occurredAt: new Date().toISOString(),
    source: { component: "crew-lead" },
    correlationId: taskId ? "task:" + taskId : "task:unknown",
    data: {
      taskId: taskId || "",
      agentId: agentId || "",
      taskType: data.taskType || "task",
      phase,
      phaseOrdinal: nextPhaseOrdinal(taskId || "global"),
      ...(data.durationMs != null && { durationMs: data.durationMs }),
      ...(data.result && { result: data.result }),
      ...(data.error && { error: data.error }),
    },
  };
  telemetryEvents.push(envelope);
  if (telemetryEvents.length > TELEMETRY_EVENT_LIMIT) telemetryEvents.shift();
  _broadcastSSE({ type: "telemetry", payload: envelope });
}

export function readTelemetryEvents(limit = 25) {
  const n = Math.min(Number(limit) || 25, TELEMETRY_EVENT_LIMIT);
  return telemetryEvents.slice(-n);
}

export function bumpOpsCounter(key, delta = 1) {
  OPS_COUNTERS[key] = (OPS_COUNTERS[key] || 0) + delta;
}

export function recordOpsEvent(type, fields = {}) {
  const entry = { ts: Date.now(), type, ...fields };
  OPS_EVENTS.push(entry);
  if (OPS_EVENTS.length > OPS_EVENT_LIMIT) OPS_EVENTS.shift();
  return entry;
}

export function readOpsEvents(limit = 25) {
  if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  const sliceCount = Math.min(Math.trunc(limit), OPS_EVENT_LIMIT);
  return OPS_EVENTS.slice(sliceCount * -1);
}

export function buildTaskText(taskSpec) {
  if (typeof taskSpec === "string") return taskSpec;
  let text = taskSpec.task || "";
  if (taskSpec.verify || taskSpec.done) {
    text += "\n\n## Acceptance criteria";
    if (taskSpec.verify) text += `\n- Verify: ${taskSpec.verify}`;
    if (taskSpec.done)   text += `\n- Done when: ${taskSpec.done}`;
  }
  return text;
}

export function resolveAgentId(cfg, nameOrId) {
  if (!nameOrId) return null;
  const id = String(nameOrId).trim();
  if (cfg.knownAgents && cfg.knownAgents.includes(id)) return id;
  const roster = cfg.agentRoster || [];
  const byName = roster.find(a => (a.name || "").toLowerCase() === id.toLowerCase());
  if (byName) return byName.id;
  return id;
}
