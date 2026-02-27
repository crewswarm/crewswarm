/**
 * Formatting utilities and telemetry reader — extracted from gateway-bridge.mjs
 * Pure functions with no external injection needed.
 */

import fs   from "fs";
import os   from "os";
import path from "path";

const LEGACY_STATE_DIR = path.join(os.homedir(), ".openclaw");
const TELEMETRY_DIR    = path.join(LEGACY_STATE_DIR, "telemetry");
export const TELEMETRY_LOG = path.join(TELEMETRY_DIR, "events.log");

export function formatError(err) {
  const msg = err?.message ?? String(err);
  const lower = msg.toLowerCase();
  let hint = "Hint: run --quickstart to verify connection and channel status.";
  if (lower.includes("enoent") || lower.includes("device.json") || lower.includes("openclaw.json")) {
    hint = `Hint: initialize config (e.g. run install) so identity/config exist under ~/.crewswarm or legacy path.`;
  } else if (lower.includes("econnrefused") || lower.includes("connect") || lower.includes("websocket")) {
    hint = "Hint: start the local gateway service, then re-run with --quickstart.";
  } else if (lower.includes("timeout")) {
    hint = "Hint: gateway may be busy; retry in a few seconds or use --status to verify responsiveness.";
  }
  return `❌ ${msg}\n${hint}`;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function percentile(numbers, p) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export function readTelemetryEvents(limit = 20000) {
  try {
    if (!fs.existsSync(TELEMETRY_LOG)) return [];
    const lines = fs.readFileSync(TELEMETRY_LOG, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const events = [];
    for (const line of tail) {
      try {
        const row = JSON.parse(line);
        if (row?.event && row?.timestamp) events.push(row);
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

