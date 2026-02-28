/**
 * logger.mjs — structured log utility for CrewSwarm
 *
 * By default emits human-readable prefixed lines.
 * Set LOG_FORMAT=json to emit newline-delimited JSON (machine-parseable).
 *
 * Usage:
 *   import { log } from "../lib/runtime/logger.mjs";
 *   log("info",  "crew-lead", "RT connected", { port: 18889 });
 *   log("warn",  "wave-dispatcher", "queue full", { depth: 50, agent: "crew-coder" });
 *   log("error", "pipeline-state", "save failed", { pipelineId, error: e.message });
 */

const JSON_MODE = process.env.LOG_FORMAT === "json";

const LEVEL_PREFIX = {
  info:  "",
  warn:  "⚠️  ",
  error: "❌ ",
  debug: "🔍 ",
};

/**
 * @param {"info"|"warn"|"error"|"debug"} level
 * @param {string} component  e.g. "crew-lead", "wave-dispatcher", "pipeline-state"
 * @param {string} msg        Human-readable message
 * @param {object} [data]     Optional structured fields (correlationId, agent, taskId, …)
 */
export function log(level, component, msg, data = {}) {
  if (JSON_MODE) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...data,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const prefix = LEVEL_PREFIX[level] ?? "";
    const extras = Object.keys(data).length
      ? " " + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
      : "";
    const line = `[${component}] ${prefix}${msg}${extras}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

/**
 * Convenience wrappers
 */
export const logger = {
  info:  (component, msg, data) => log("info",  component, msg, data),
  warn:  (component, msg, data) => log("warn",  component, msg, data),
  error: (component, msg, data) => log("error", component, msg, data),
  debug: (component, msg, data) => log("debug", component, msg, data),
};
