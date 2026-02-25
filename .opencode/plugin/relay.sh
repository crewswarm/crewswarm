#!/bin/bash
# relay.sh - OpenClaw <-> Swarm relay and shared-memory helper

set -euo pipefail

API_BASE="${OPENCODE_API_BASE:-http://127.0.0.1:4096}"
AUTH="${OPENCODE_AUTH:-opencode:opencode}"
DEFAULT_ALLOWED_AGENTS="main,admin,build,coder,researcher,architect,reviewer"
ALLOWED_AGENTS="${OPENCLAW_ALLOWED_AGENTS:-$DEFAULT_ALLOWED_AGENTS}"
REQUIRE_API_KEY="${OPENCLAW_REQUIRE_API_KEY:-1}"
RELAY_API_KEY="${OPENCLAW_API_KEY:-}"
CLIENT_API_KEY="${OPENCLAW_CLIENT_API_KEY:-}"
MEMORY_BASE_DIR="${SHARED_MEMORY_DIR:-$HOME/.openclaw/workspace/shared-memory}"
MEMORY_NAMESPACE="${SHARED_MEMORY_NAMESPACE:-claw-swarm}"
MEMORY_DIR="${MEMORY_BASE_DIR}/${MEMORY_NAMESPACE}"
REQUIRE_SIGNATURE="${OPENCLAW_REQUIRE_SIGNATURE:-0}"
SIGNING_SECRET="${OPENCLAW_SIGNING_SECRET:-}"
SIG_WINDOW_SEC="${OPENCLAW_SIG_WINDOW_SEC:-300}"
NONCE_DIR="${MEMORY_DIR}/.relay-nonces"
CLIENT_TIMESTAMP=""
CLIENT_NONCE=""
CLIENT_SIGNATURE=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
  cat <<EOF
Usage:
  $0 [--api-key <key>] title <session_id> <task_description> [primary|subagent]
  $0 [--api-key <key>] call <session_id> <message> [agent]
  $0 [--api-key <key>] status [session_id]
  $0 [--api-key <key>] relay-check [session_id]
  $0 [--api-key <key>] memory-write <key> <value> [--append]
  $0 [--api-key <key>] memory-read <key>
  $0 [--api-key <key>] memory-list
  $0 [--api-key <key>] memory-delete <key>

Backward compatible title mode:
  $0 <session_id> <task_description> [primary|subagent]
EOF
  exit 1
}

require_api_key() {
  if [[ "$REQUIRE_API_KEY" == "0" ]]; then
    return 0
  fi
  if [[ -z "$RELAY_API_KEY" ]]; then
    log_error "OPENCLAW_API_KEY is required but not configured"
    exit 1
  fi
  if [[ -z "$CLIENT_API_KEY" || "$CLIENT_API_KEY" != "$RELAY_API_KEY" ]]; then
    log_error "Unauthorized: invalid api key"
    exit 1
  fi
}

sha256_text() {
  python3 - <<'PY' "$1"
import hashlib, sys
print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
PY
}

hmac_sha256() {
  python3 - <<'PY' "$1" "$2"
import hmac, hashlib, sys
secret = sys.argv[1].encode()
payload = sys.argv[2].encode()
print(hmac.new(secret, payload, hashlib.sha256).hexdigest())
PY
}

secure_compare() {
  python3 - <<'PY' "$1" "$2"
import hmac, sys
print("1" if hmac.compare_digest(sys.argv[1], sys.argv[2]) else "0")
PY
}

prune_nonce_cache() {
  [[ -d "$NONCE_DIR" ]] || return 0
  local now
  now="$(date +%s)"
  shopt -s nullglob
  local files=("$NONCE_DIR"/*.nonce)
  shopt -u nullglob
  for f in "${files[@]}"; do
    local ts
    ts="$(cat "$f" 2>/dev/null || true)"
    [[ "$ts" =~ ^[0-9]+$ ]] || { rm -f "$f"; continue; }
    if (( now - ts > SIG_WINDOW_SEC * 3 )); then
      rm -f "$f"
    fi
  done
}

require_signature() {
  local action="$1"
  local payload="$2"

  if [[ "$REQUIRE_SIGNATURE" != "1" ]]; then
    return 0
  fi

  if [[ -z "$SIGNING_SECRET" ]]; then
    log_error "OPENCLAW_SIGNING_SECRET must be configured when OPENCLAW_REQUIRE_SIGNATURE=1"
    exit 1
  fi

  if [[ -z "$CLIENT_TIMESTAMP" || -z "$CLIENT_NONCE" || -z "$CLIENT_SIGNATURE" ]]; then
    log_error "Missing signature params. Provide --timestamp, --nonce, and --signature"
    exit 1
  fi

  if [[ ! "$CLIENT_TIMESTAMP" =~ ^[0-9]+$ ]]; then
    log_error "Invalid timestamp format"
    exit 1
  fi

  if [[ ! "$CLIENT_NONCE" =~ ^[A-Za-z0-9._-]{8,128}$ ]]; then
    log_error "Invalid nonce format"
    exit 1
  fi

  local now drift
  now="$(date +%s)"
  drift=$(( now - CLIENT_TIMESTAMP ))
  if (( drift < 0 )); then
    drift=$(( -drift ))
  fi
  if (( drift > SIG_WINDOW_SEC )); then
    log_error "Signature timestamp outside allowed window (${SIG_WINDOW_SEC}s)"
    exit 1
  fi

  mkdir -p "$NONCE_DIR"
  prune_nonce_cache
  local nonce_file="${NONCE_DIR}/${CLIENT_NONCE}.nonce"
  if [[ -f "$nonce_file" ]]; then
    log_error "Replay detected: nonce already used"
    exit 1
  fi

  local payload_hash expected base compare
  payload_hash="$(sha256_text "$payload")"
  base="${CLIENT_TIMESTAMP}|${CLIENT_NONCE}|${action}|${payload_hash}"
  expected="$(hmac_sha256 "$SIGNING_SECRET" "$base")"
  compare="$(secure_compare "$CLIENT_SIGNATURE" "$expected")"
  if [[ "$compare" != "1" ]]; then
    log_error "Invalid signature"
    exit 1
  fi

  printf '%s' "$CLIENT_TIMESTAMP" > "$nonce_file"
}

require_security() {
  local action="$1"
  local payload="$2"
  require_api_key
  require_signature "$action" "$payload"
}

agent_allowed() {
  local candidate="$1"
  IFS=',' read -ra agents <<< "$ALLOWED_AGENTS"
  for a in "${agents[@]}"; do
    a="$(echo "$a" | xargs)"
    [[ "$a" == "*" || "$a" == "$candidate" ]] && return 0
  done
  return 1
}

validate_key() {
  local key="$1"
  if [[ ! "$key" =~ ^[A-Za-z0-9._-]{1,80}$ ]]; then
    log_error "Invalid key '$key'"
    exit 1
  fi
}

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

api_request() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  if [[ -n "$payload" ]]; then
    curl -sS -u "$AUTH" -X "$method" -H "Content-Type: application/json" -d "$payload" "$url"
  else
    curl -sS -u "$AUTH" -X "$method" "$url"
  fi
}

cmd_title() {
  local session_id="$1"
  local task_description="$2"
  local role="${3:-primary}"

  [[ "$role" != "primary" && "$role" != "subagent" ]] && role="primary"

  local new_title
  if [[ "$role" == "subagent" ]]; then
    new_title="${task_description} (@${session_id:4:8} subagent)"
  else
    new_title="$task_description"
  fi

  local payload
  payload="{\"title\":$(json_escape "$new_title")}" 
  local response
  response="$(api_request PATCH "${API_BASE}/session/${session_id}" "$payload")"

  if [[ "$response" == *'"id"'* ]]; then
    log_info "Updated title for ${session_id}"
  else
    log_error "Failed to update title: ${response}"
    exit 1
  fi
}

cmd_call() {
  local session_id="$1"
  local message="$2"
  local agent="${3:-main}"

  require_security "call" "${session_id}|${agent}|${message}"
  if ! agent_allowed "$agent"; then
    log_error "Agent '$agent' is not in OPENCLAW_ALLOWED_AGENTS"
    exit 1
  fi

  local escaped_message escaped_agent payload response
  escaped_message="$(json_escape "$message")"
  escaped_agent="$(json_escape "$agent")"
  payload="{\"agent\":${escaped_agent},\"parts\":[{\"type\":\"text\",\"text\":${escaped_message}}]}"

  response="$(api_request POST "${API_BASE}/session/${session_id}/prompt" "$payload")"
  if [[ "$response" == *'"id"'* || "$response" == *'"ok"'* ]]; then
    log_info "Prompt delivered to session ${session_id} (agent: ${agent})"
  else
    log_error "Prompt failed: ${response}"
    exit 1
  fi
}

cmd_status() {
  local session_id="${1:-}"
  require_security "status" "${session_id}"
  if [[ -n "$session_id" ]]; then
    api_request GET "${API_BASE}/session/${session_id}"
  else
    api_request GET "${API_BASE}/session"
  fi
}

cmd_relay_check() {
  local session_id="${1:-}"
  local ok="1"
  local bridge_path="${OPENCLAW_BRIDGE_PATH:-$HOME/Desktop/OpenClaw/gateway-bridge.mjs}"

  echo "relay-check"
  echo "- API base: ${API_BASE}"
  echo "- Memory namespace: ${MEMORY_NAMESPACE}"

  for dep in curl python3 node; do
    if command -v "$dep" >/dev/null 2>&1; then
      echo "[OK] dependency: ${dep}"
    else
      echo "[FAIL] missing dependency: ${dep}"
      ok="0"
    fi
  done

  if [[ "$REQUIRE_API_KEY" == "1" ]]; then
    if [[ -n "$RELAY_API_KEY" ]]; then
      echo "[OK] API key configured"
    else
      echo "[FAIL] OPENCLAW_API_KEY missing"
      ok="0"
    fi
  else
    echo "[OK] API key requirement disabled"
  fi

  if [[ "$REQUIRE_SIGNATURE" == "1" ]]; then
    if [[ -n "$SIGNING_SECRET" ]]; then
      echo "[OK] signature secret configured"
    else
      echo "[FAIL] OPENCLAW_SIGNING_SECRET missing"
      ok="0"
    fi
  else
    echo "[OK] request signature disabled"
  fi

  mkdir -p "$MEMORY_DIR"
  local probe="${MEMORY_DIR}/.relay-check.$$.tmp"
  if printf 'ok' > "$probe" 2>/dev/null; then
    rm -f "$probe"
    echo "[OK] memory directory writable"
  else
    echo "[FAIL] memory directory not writable: ${MEMORY_DIR}"
    ok="0"
  fi

  if [[ -f "$bridge_path" ]]; then
    echo "[OK] bridge path found: ${bridge_path}"
  else
    echo "[FAIL] bridge path missing: ${bridge_path}"
    ok="0"
  fi

  local api_resp
  if api_resp="$(api_request GET "${API_BASE}/session" 2>/dev/null)"; then
    if [[ "$api_resp" == *"ses_"* || "$api_resp" == *"[]"* || "$api_resp" == *'"id"'* ]]; then
      echo "[OK] OpenCode API reachable"
    else
      echo "[WARN] OpenCode API responded with unexpected payload"
    fi
  else
    echo "[FAIL] OpenCode API unreachable"
    ok="0"
  fi

  if [[ -n "$session_id" ]]; then
    local sess_resp
    if sess_resp="$(api_request GET "${API_BASE}/session/${session_id}" 2>/dev/null)" && [[ "$sess_resp" == *"${session_id}"* ]]; then
      echo "[OK] session exists: ${session_id}"
    else
      echo "[FAIL] session not found or inaccessible: ${session_id}"
      ok="0"
    fi
  fi

  if [[ "$ok" == "1" ]]; then
    echo "[OK] relay-check passed"
  else
    echo "[FAIL] relay-check failed"
    exit 1
  fi
}

cmd_memory_write() {
  local key="$1"
  local value="$2"
  local append_mode="${3:-0}"
  require_security "memory-write" "${key}|${value}|${append_mode}"
  validate_key "$key"
  mkdir -p "$MEMORY_DIR"
  local file="${MEMORY_DIR}/${key}.txt"
  if [[ "$append_mode" == "1" && -f "$file" ]]; then
    printf '\n%s' "$value" >> "$file"
  else
    printf '%s' "$value" > "$file"
  fi
  log_info "Wrote key '${key}' in namespace '${MEMORY_NAMESPACE}'"
}

cmd_memory_read() {
  local key="$1"
  require_security "memory-read" "${key}"
  validate_key "$key"
  local file="${MEMORY_DIR}/${key}.txt"
  [[ -f "$file" ]] || { log_error "Key not found: ${key}"; exit 1; }
  cat "$file"
}

cmd_memory_list() {
  require_security "memory-list" "list"
  mkdir -p "$MEMORY_DIR"
  shopt -s nullglob
  local files=("$MEMORY_DIR"/*.txt)
  shopt -u nullglob
  if (( ${#files[@]} == 0 )); then
    echo "[memory:${MEMORY_NAMESPACE}] (no keys)"
    return 0
  fi
  echo "[memory:${MEMORY_NAMESPACE}]"
  for f in "${files[@]}"; do
    basename "$f" .txt
  done
}

cmd_memory_delete() {
  local key="$1"
  require_security "memory-delete" "${key}"
  validate_key "$key"
  local file="${MEMORY_DIR}/${key}.txt"
  [[ -f "$file" ]] || { log_error "Key not found: ${key}"; exit 1; }
  rm -f "$file"
  log_info "Deleted key '${key}' from namespace '${MEMORY_NAMESPACE}'"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      [[ $# -lt 2 ]] && usage
      CLIENT_API_KEY="$2"
      shift 2
      ;;
    --timestamp)
      [[ $# -lt 2 ]] && usage
      CLIENT_TIMESTAMP="$2"
      shift 2
      ;;
    --nonce)
      [[ $# -lt 2 ]] && usage
      CLIENT_NONCE="$2"
      shift 2
      ;;
    --signature)
      [[ $# -lt 2 ]] && usage
      CLIENT_SIGNATURE="$2"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -lt 1 ]] && usage

if [[ "$1" == "title" ]]; then
  [[ $# -lt 3 ]] && usage
  cmd_title "$2" "$3" "${4:-primary}"
  exit 0
fi

if [[ "$1" == "call" ]]; then
  [[ $# -lt 3 ]] && usage
  cmd_call "$2" "$3" "${4:-main}"
  exit 0
fi

if [[ "$1" == "status" ]]; then
  cmd_status "${2:-}"
  exit 0
fi

if [[ "$1" == "relay-check" ]]; then
  cmd_relay_check "${2:-}"
  exit 0
fi

if [[ "$1" == "memory-write" ]]; then
  [[ $# -lt 3 ]] && usage
  append="0"
  [[ "${4:-}" == "--append" ]] && append="1"
  cmd_memory_write "$2" "$3" "$append"
  exit 0
fi

if [[ "$1" == "memory-read" ]]; then
  [[ $# -lt 2 ]] && usage
  cmd_memory_read "$2"
  exit 0
fi

if [[ "$1" == "memory-list" ]]; then
  cmd_memory_list
  exit 0
fi

if [[ "$1" == "memory-delete" ]]; then
  [[ $# -lt 2 ]] && usage
  cmd_memory_delete "$2"
  exit 0
fi

# Backward-compatible default mode: title update
if [[ $# -ge 2 ]]; then
  cmd_title "$1" "$2" "${3:-primary}"
  exit 0
fi

usage
