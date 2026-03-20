#!/usr/bin/env bash
# Restart a named CrewSwarm service using the canonical service-control path.
# This is the shared entrypoint used by SwiftBar and the dashboard API.

set -euo pipefail

SERVICE_ID="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CREWSWARM_DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$REPO_ROOT}}"
PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin:/usr/bin:/bin:${PATH:-}"
export PATH

if [[ -z "$SERVICE_ID" ]]; then
  echo "Usage: $0 <service-id>"
  echo "Valid IDs: rt-bus, agents, telegram, whatsapp, crew-lead, opencode, mcp, studio, studio-watch, dashboard, openclaw-gateway"
  exit 1
fi

NODE_BIN="${NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x /usr/local/bin/node ]]; then
    NODE_BIN="/usr/local/bin/node"
  elif [[ -x /opt/homebrew/bin/node ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  else
    echo "❌ node not found in PATH"
    exit 1
  fi
fi

_launchctl_restart() {
  local label="$1"
  if launchctl list "$label" >/dev/null 2>&1; then
    launchctl stop "$label" 2>/dev/null || true
    sleep 1
    launchctl start "$label" 2>/dev/null
    return 0
  fi
  return 1
}

_config_value() {
  local file="$1"
  local expr="$2"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, expr] = process.argv.slice(1);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const value = expr.split(".").reduce((obj, key) => obj?.[key], cfg);
      process.stdout.write(value == null ? "" : String(value));
    } catch {
      process.stdout.write("");
    }
  ' "$file" "$expr"
}

_wait_for_port_free() {
  local port="$1"
  local attempts="${2:-10}"
  for ((i=1; i<=attempts; i++)); do
    if ! lsof -ti :"$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

_start_detached() {
  local log_file="$1"
  shift
  nohup "$@" >> "$log_file" 2>&1 < /dev/null &
}

_rt_token() {
  local home="$HOME"
  local token
  token="$(_config_value "$home/.crewswarm/crewswarm.json" "rt.authToken")"
  if [[ -n "$token" ]]; then
    printf "%s" "$token"
    return 0
  fi
  token="$(_config_value "$home/.crewswarm/crewswarm.json" "env.CREWSWARM_RT_AUTH_TOKEN")"
  if [[ -n "$token" ]]; then
    printf "%s" "$token"
    return 0
  fi
  token="$(_config_value "$home/.openclaw/openclaw.json" "env.CREWSWARM_RT_AUTH_TOKEN")"
  printf "%s" "$token"
}

_allowed_agents() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const agentSet = new Set([
      "main","admin","build","coder","researcher","architect","reviewer","qa","fixer","pm","orchestrator",
      "openclaw","openclaw-main","opencode-pm","opencode-qa","opencode-fixer","opencode-coder","opencode-coder-2",
      "security","crew-lead"
    ]);
    for (const file of [
      path.join(os.homedir(), ".crewswarm", "crewswarm.json"),
      path.join(os.homedir(), ".openclaw", "openclaw.json")
    ]) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        const list = Array.isArray(cfg.agents) ? cfg.agents : (cfg.agents?.list || []);
        for (const agent of list) {
          const rawId = String(agent.id || "").trim();
          if (!rawId) continue;
          const bareId = rawId.replace(/^crew-/, "");
          const rtId = rawId.startsWith("crew-") ? rawId : `crew-${bareId}`;
          agentSet.add(rtId);
          agentSet.add(bareId);
        }
      } catch {}
    }
    process.stdout.write([...agentSet].sort().join(","));
  '
}

case "$SERVICE_ID" in
  dashboard)
    exec bash "$CREWSWARM_DIR/scripts/restart-dashboard.sh"
    ;;
  crew-lead)
    exec bash "$CREWSWARM_DIR/scripts/restart-crew-lead.sh"
    ;;
  rt-bus)
    pkill -f "opencrew-rt-daemon" 2>/dev/null || true
    _wait_for_port_free 18889 12 || true
    _start_detached /tmp/opencrew-rt-daemon.log \
      env \
      CREWSWARM_RT_AUTH_TOKEN="$(_rt_token)" \
      OPENCLAW_ALLOWED_AGENTS="$(_allowed_agents)" \
      "$NODE_BIN" "$CREWSWARM_DIR/scripts/opencrew-rt-daemon.mjs"
    echo "✅ rt-bus restart requested"
    ;;
  agents)
    pkill -f "gateway-bridge.mjs --rt-daemon" 2>/dev/null || true
    find /tmp -maxdepth 1 -name "bridge-*.pid" -delete 2>/dev/null || true
    sleep 1
    _start_detached /tmp/start-crew.log \
      env \
      CREWSWARM_DIR="$CREWSWARM_DIR" \
      SKIP_CREW_LEAD=1 \
      "$NODE_BIN" "$CREWSWARM_DIR/scripts/start-crew.mjs" --force
    echo "✅ agents restart requested"
    ;;
  telegram)
    launchctl stop com.crewswarm.telegram 2>/dev/null || true
    TG_TOKEN="${TELEGRAM_BOT_TOKEN:-$(_config_value "$HOME/.crewswarm/telegram-bridge.json" "token")}"
    if [[ -z "$TG_TOKEN" ]]; then
      echo "❌ Telegram not configured — set TELEGRAM_BOT_TOKEN or ~/.crewswarm/telegram-bridge.json"
      exit 1
    fi
    pkill -f "telegram-bridge.mjs" 2>/dev/null || true
    sleep 1
    _start_detached /tmp/telegram-bridge.log \
      env \
      TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
      TELEGRAM_TARGET_AGENT="$(_config_value "$HOME/.crewswarm/telegram-bridge.json" "targetAgent")" \
      CREWSWARM_RT_AUTH_TOKEN="$(_rt_token)" \
      "$NODE_BIN" "$CREWSWARM_DIR/telegram-bridge.mjs"
    echo "✅ telegram restart requested"
    ;;
  whatsapp)
    # Skip launchd — EAGAIN errors under launchd sandboxing; use nohup instead
    pkill -f "whatsapp-bridge.mjs" 2>/dev/null || true
    sleep 1
    _start_detached "$HOME/.crewswarm/logs/whatsapp-bridge-stdout.log" \
      env \
      WA_ALLOWED_NUMBERS="$(_config_value "$HOME/.crewswarm/crewswarm.json" "env.WA_ALLOWED_NUMBERS")" \
      CREWSWARM_RT_AUTH_TOKEN="$(_rt_token)" \
      "$NODE_BIN" "$CREWSWARM_DIR/whatsapp-bridge.mjs"
    echo "✅ whatsapp restart requested"
    ;;
  opencode)
    pkill -f "opencode serve" 2>/dev/null || true
    sleep 1
    OPENCODE_BIN="$(command -v opencode || true)"
    if [[ -z "$OPENCODE_BIN" && -x /usr/local/bin/opencode ]]; then
      OPENCODE_BIN="/usr/local/bin/opencode"
    fi
    if [[ -z "$OPENCODE_BIN" && -x /opt/homebrew/bin/opencode ]]; then
      OPENCODE_BIN="/opt/homebrew/bin/opencode"
    fi
    if [[ -z "$OPENCODE_BIN" ]]; then
      echo "❌ opencode not found in PATH"
      exit 1
    fi
    _start_detached /tmp/opencode.log \
      "$OPENCODE_BIN" serve --port 4096 --hostname 127.0.0.1
    echo "✅ opencode restart requested"
    ;;
  mcp)
    pkill -f "mcp-server.mjs" 2>/dev/null || true
    lsof -ti :5020 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    _start_detached /tmp/crewswarm-mcp.log \
      "$NODE_BIN" "$CREWSWARM_DIR/scripts/mcp-server.mjs"
    echo "✅ mcp restart requested"
    ;;
  studio)
    pkill -f "vite.*studio" 2>/dev/null || true
    pkill -f "apps/vibe/server.mjs" 2>/dev/null || true
    lsof -ti :3333 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :3335 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    _start_detached /tmp/studio.log \
      npm run studio:start --prefix "$CREWSWARM_DIR"
    echo "✅ studio restart requested"
    ;;
  studio-watch)
    pkill -f "watch-server.mjs" 2>/dev/null || true
    lsof -ti :3334 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    _start_detached /tmp/studio-watch.log \
      npm run studio:watch --prefix "$CREWSWARM_DIR"
    echo "✅ studio-watch restart requested"
    ;;
  openclaw-gateway)
    pkill -f "openclaw-gateway" 2>/dev/null || true
    sleep 1
    if [[ "${OSTYPE:-}" == darwin* ]]; then
      open -a OpenClaw >/dev/null 2>&1 || true
    fi
    echo "✅ openclaw-gateway restart requested"
    ;;
  *)
    echo "❌ Unknown service: $SERVICE_ID"
    exit 1
    ;;
esac
