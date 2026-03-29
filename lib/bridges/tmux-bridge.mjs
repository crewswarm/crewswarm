/**
 * tmux-bridge adapter — thin wrapper around smux's tmux-bridge CLI
 *
 * Provides agent-to-agent pane communication when running inside a tmux session
 * with smux installed. All functions degrade to no-ops when unavailable.
 *
 * Opt-in: requires $TMUX set, `tmux-bridge` on PATH, and
 *   CREWSWARM_TMUX_BRIDGE=1 env var (or tmuxBridge: true in system config).
 */

import { execFileSync, execSync } from "node:child_process";

function which(bin) {
  try { execSync(`which ${bin}`, { stdio: "ignore" }); return true; } catch { return false; }
}

// ── Detection & caching ─────────────────────────────────────────────────────

let _available = null;
let _ownPaneId = null;
const _resolveCache = new Map(); // label → { paneId, ts }
const RESOLVE_TTL_MS = 30_000;
const TMUX_BRIDGE_BIN = process.env.SMUX_BRIDGE_BIN || "tmux-bridge";

function exec(args, { timeout = 5000 } = {}) {
  try {
    return execFileSync(TMUX_BRIDGE_BIN, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if tmux-bridge is available and opted-in.
 * Result is cached for the process lifetime.
 */
export function detect() {
  if (_available !== null) return _available;

  // Must be inside a tmux session
  if (!process.env.TMUX) {
    _available = false;
    return false;
  }

  // Must have tmux-bridge binary
  if (!which(TMUX_BRIDGE_BIN)) {
    _available = false;
    return false;
  }

  // Must be opted-in via env var or config
  const envFlag = process.env.CREWSWARM_TMUX_BRIDGE;
  if (!envFlag || envFlag === "0" || envFlag === "false") {
    _available = false;
    return false;
  }

  _available = true;
  return true;
}

/**
 * Get this process's own tmux pane ID.
 * @returns {string|null} e.g. "%3"
 */
export function id() {
  if (!detect()) return null;
  if (_ownPaneId) return _ownPaneId;
  _ownPaneId = exec(["id"]);
  return _ownPaneId;
}

/**
 * Label a pane with an agent ID so other agents can discover it.
 * @param {string} agentId - CrewSwarm agent ID (e.g. "crew-coder")
 * @param {string} [paneId] - Target pane ID. Defaults to own pane.
 * @returns {boolean} success
 */
export function label(agentId, paneId) {
  if (!detect()) return false;
  const target = paneId || id();
  if (!target) return false;
  const result = exec(["name", target, agentId]);
  if (result !== null) {
    // Update cache
    _resolveCache.set(agentId, { paneId: target, ts: Date.now() });
    return true;
  }
  return false;
}

/**
 * Resolve an agent ID to a tmux pane ID.
 * @param {string} agentId
 * @returns {string|null} pane ID or null
 */
export function resolve(agentId) {
  if (!detect()) return null;

  // Check cache
  const cached = _resolveCache.get(agentId);
  if (cached && (Date.now() - cached.ts) < RESOLVE_TTL_MS) {
    return cached.paneId;
  }

  const paneId = exec(["resolve", agentId]);
  if (paneId) {
    _resolveCache.set(agentId, { paneId, ts: Date.now() });
  }
  return paneId;
}

/**
 * Read the last N lines from an agent's pane.
 * Also satisfies the read-guard requirement for subsequent sends.
 * @param {string} agentId
 * @param {number} [lines=50]
 * @returns {string|null} pane content or null
 */
export function read(agentId, lines = 50) {
  if (!detect()) return null;
  const paneId = resolve(agentId);
  if (!paneId) return null;
  const output = exec(["read", paneId, String(lines)]);
  return output;
}

/**
 * Send text to an agent's pane followed by Enter.
 * Reads the pane before each write command to satisfy tmux-bridge's read-guard
 * (the guard is consumed on every type/keys call).
 * @param {string} agentId
 * @param {string} text
 * @returns {boolean} success
 */
export function send(agentId, text) {
  if (!detect()) return false;
  const paneId = resolve(agentId);
  if (!paneId) return false;

  // Read-guard is consumed on each type/keys call, so read before each one
  exec(["read", paneId, "1"]);
  const typeResult = exec(["type", paneId, text]);
  if (typeResult === null) return false;

  exec(["read", paneId, "1"]);
  const keyResult = exec(["keys", paneId, "Enter"]);
  return keyResult !== null;
}

/**
 * List all tmux panes with their labels and metadata.
 * @returns {Array<{paneId: string, label: string, raw: string}>}
 */
export function list() {
  if (!detect()) return [];
  const raw = exec(["list"]);
  if (!raw) return [];

  // Parse tmux-bridge list output:
  //   TARGET   SESSION:WIN      SIZE       PROCESS                   LABEL      CWD
  //   %0       crewtest:0       120x29     -zsh                      crew-coder ~/CrewSwarm
  const lines = raw.split("\n").filter(Boolean);
  // Skip header row (starts with "TARGET")
  return lines
    .filter(line => line.trimStart().startsWith("%"))
    .map(line => {
      const parts = line.split(/\s+/).filter(Boolean);
      return {
        paneId: parts[0] || "",
        session: parts[1] || "",
        size: parts[2] || "",
        process: parts[3] || "",
        label: (parts[4] && parts[4] !== "-") ? parts[4] : "",
        cwd: parts[5] || "",
        raw: line,
      };
    });
}

/**
 * Clear the resolve cache (useful after pane layout changes).
 */
export function clearCache() {
  _resolveCache.clear();
}

/**
 * Reset detection state (for testing).
 */
export function _reset() {
  _available = null;
  _ownPaneId = null;
  clearCache();
}
