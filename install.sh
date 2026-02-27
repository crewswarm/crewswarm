#!/usr/bin/env bash
# CrewSwarm — first-time install script for macOS
# Usage: bash install.sh
# Or via curl: bash <(curl -fsSL https://raw.githubusercontent.com/CrewSwarm/CrewSwarm/main/install.sh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREWSWARM_DIR="$HOME/.crewswarm"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▶${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
skip()    { echo -e "  ${YELLOW}–${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*"; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

header "╔════════════════════════════════╗"
header "║     CrewSwarm  Installer       ║"
header "╚════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
header "1/7  Checking prerequisites"

if ! command -v node &>/dev/null; then
  warn "Node.js not found."
  echo ""
  echo "  Install Node.js 20+ from https://nodejs.org  (or via Homebrew):"
  echo "    brew install node"
  echo ""
  error "Please install Node.js 20+ and re-run this script."
fi

NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 20 ]]; then
  error "Node.js 20+ required (found v$NODE_VERSION). Update from https://nodejs.org"
fi
success "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  error "npm not found. Reinstall Node.js from https://nodejs.org"
fi
success "npm $(npm --version)"

# ── 2. npm install ───────────────────────────────────────────────────────────
header "2/7  Installing Node dependencies"
cd "$REPO_DIR"
npm install --silent
success "npm packages installed"

# ── 3. Create config directories ─────────────────────────────────────────────
header "3/7  Setting up config directories"

mkdir -p "$CREWSWARM_DIR"
mkdir -p "$CREWSWARM_DIR/chat-history"
success "Created ~/.crewswarm"

# ── 4. Bootstrap config files ────────────────────────────────────────────────
header "4/7  Bootstrapping config files"

CONFIG_FILE="$CREWSWARM_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  RT_TOKEN="crewswarm-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 16)"
  cat > "$CONFIG_FILE" <<EOF
{
  "_note": "RT bus auth token — do not share. Providers and agents are in crewswarm.json",
  "rt": {
    "authToken": "$RT_TOKEN"
  }
}
EOF
  success "Created ~/.crewswarm/config.json  (RT token: $RT_TOKEN)"
else
  success "~/.crewswarm/config.json already exists — keeping it"
fi

CREWSWARM_JSON="$CREWSWARM_DIR/crewswarm.json"
if [[ ! -f "$CREWSWARM_JSON" ]]; then
  cat > "$CREWSWARM_JSON" <<'EOF'
{
  "_note": "CrewSwarm agent config — edit models and providers here. All agents default to Groq (free). Swap any model to your preferred provider once you add API keys.",
  "agents": [
    { "id": "crew-lead",         "model": "groq/llama-3.3-70b-versatile", "_note": "Stinki — conversational commander. Runs on port 5010." },
    { "id": "crew-main",         "model": "groq/llama-3.3-70b-versatile", "_note": "General coordinator, fallback agent" },
    { "id": "crew-pm",           "model": "groq/llama-3.3-70b-versatile", "_note": "Planning, roadmaps, task breakdown" },
    { "id": "crew-coder",        "model": "groq/llama-3.3-70b-versatile", "_note": "Full-stack coding" },
    { "id": "crew-coder-front",  "model": "groq/llama-3.3-70b-versatile", "_note": "Frontend / HTML / CSS / JS" },
    { "id": "crew-coder-back",   "model": "groq/llama-3.3-70b-versatile", "_note": "Backend / API / database" },
    { "id": "crew-frontend",     "model": "groq/llama-3.3-70b-versatile", "_note": "CSS / design polish" },
    { "id": "crew-qa",           "model": "groq/llama-3.3-70b-versatile", "_note": "Testing and QA audits" },
    { "id": "crew-fixer",        "model": "groq/llama-3.3-70b-versatile", "_note": "Bug fixing, root cause analysis" },
    { "id": "crew-security",     "model": "groq/llama-3.3-70b-versatile", "_note": "Security audits" },
    { "id": "crew-github",       "model": "groq/llama-3.3-70b-versatile", "_note": "Git commits, branches, PRs" },
    { "id": "crew-copywriter",   "model": "groq/llama-3.3-70b-versatile", "_note": "Writing, docs, marketing copy" },
    { "id": "crew-seo",          "model": "groq/llama-3.3-70b-versatile", "_note": "SEO, structured data, performance" },
    { "id": "crew-researcher",   "model": "groq/llama-3.3-70b-versatile", "_note": "Web research and analysis — swap to perplexity/sonar for best results" },
    { "id": "crew-mega",         "model": "groq/llama-3.3-70b-versatile", "_note": "High-performance generalist — swap to a frontier model (claude, gpt-4o) for heavy tasks" },
    { "id": "crew-architect",    "model": "groq/llama-3.3-70b-versatile", "_note": "Project structure, path enforcement, correctness" },
    { "id": "crew-ml",           "model": "groq/llama-3.3-70b-versatile", "_note": "AI/ML pipelines and data work" },
    { "id": "orchestrator",      "model": "groq/llama-3.3-70b-versatile", "_note": "PM-loop orchestrator — reads roadmaps and routes tasks" }
  ],
  "providers": {
    "groq":        { "apiKey": "", "baseUrl": "https://api.groq.com/openai/v1" },
    "anthropic":   { "apiKey": "", "baseUrl": "https://api.anthropic.com/v1" },
    "openai":      { "apiKey": "", "baseUrl": "https://api.openai.com/v1" },
    "xai":         { "apiKey": "", "baseUrl": "https://api.x.ai/v1" },
    "deepseek":    { "apiKey": "", "baseUrl": "https://api.deepseek.com/v1" },
    "mistral":     { "apiKey": "", "baseUrl": "https://api.mistral.ai/v1" },
    "cerebras":    { "apiKey": "", "baseUrl": "https://api.cerebras.ai/v1" },
    "perplexity":  { "apiKey": "", "baseUrl": "https://api.perplexity.ai" },
    "nvidia":      { "apiKey": "", "baseUrl": "https://integrate.api.nvidia.com/v1" },
    "google":      { "apiKey": "", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai" },
    "ollama":      { "apiKey": "ollama", "baseUrl": "http://localhost:11434/v1" }
  }
}
EOF
  success "Created ~/.crewswarm/crewswarm.json  (all agents on Groq Llama 3.3 70B — add your key to start)"
else
  success "~/.crewswarm/crewswarm.json already exists — keeping it"
fi

# Bootstrap skills directory with starter skill definitions
SKILLS_DIR="$CREWSWARM_DIR/skills"
mkdir -p "$SKILLS_DIR"
if [[ -d "$REPO_DIR/skills" ]]; then
  for f in "$REPO_DIR/skills"/*.json; do
    [[ -f "$f" ]] || continue
    dest="$SKILLS_DIR/$(basename "$f")"
    cp "$f" "$dest"
  done
  success "Skills synced to ~/.crewswarm/skills/"
fi

# Bootstrap agent prompts if not present (try repo config/prompts/ dir, or empty default)
PROMPTS_FILE="$CREWSWARM_DIR/agent-prompts.json"
if [[ ! -f "$PROMPTS_FILE" ]]; then
  if [[ -f "$REPO_DIR/config/agent-prompts.json" ]]; then
    cp "$REPO_DIR/config/agent-prompts.json" "$PROMPTS_FILE"
    success "Copied config/agent-prompts.json to ~/.crewswarm/"
  else
    echo '{}' > "$PROMPTS_FILE"
    success "Created ~/.crewswarm/agent-prompts.json"
    if [[ -d "$REPO_DIR/prompts" ]] && [[ -n "$(find "$REPO_DIR/prompts" -maxdepth 1 -name '*.md' 2>/dev/null)" ]]; then
      (cd "$REPO_DIR" && node scripts/sync-prompts.mjs 2>/dev/null) && success "Seeded agent prompts from repo prompts/*.md" || true
    fi
  fi
fi

ALLOWLIST="$CREWSWARM_DIR/cmd-allowlist.json"
if [[ ! -f "$ALLOWLIST" ]]; then
  echo '{"patterns":["npm *","node *","npx *"]}' > "$ALLOWLIST"
  success "Created ~/.crewswarm/cmd-allowlist.json  (npm, node, npx pre-approved)"
fi

TOKEN_FILE="$CREWSWARM_DIR/token-usage.json"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo '{"calls":0,"promptTokens":0,"completionTokens":0,"totalTokens":0,"estimatedCostUSD":0,"byModel":{}}' > "$TOKEN_FILE"
fi

# ── 5. Shell alias ────────────────────────────────────────────────────────────
header "5/7  Shell alias"

SHELL_RC=""
if [[ "$SHELL" == *"zsh"* ]]; then
  SHELL_RC="$HOME/.zshrc"
elif [[ "$SHELL" == *"bash"* ]]; then
  SHELL_RC="$HOME/.bash_profile"
fi

BIN_ALIAS="alias crew-cli='node $REPO_DIR/crew-cli.mjs'"
if [[ -n "$SHELL_RC" ]] && ! grep -q "crew-cli" "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo "# CrewSwarm" >> "$SHELL_RC"
  echo "$BIN_ALIAS" >> "$SHELL_RC"
  success "Added crew-cli alias to $SHELL_RC"
else
  success "crew-cli alias already set"
fi

# ── 6. Optional extras ────────────────────────────────────────────────────────
header "6/7  Optional extras"

# ── 6a. SwiftBar menu bar plugin ─────────────────────────────────────────────
SWIFTBAR_PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
SWIFTBAR_APP="/Applications/SwiftBar.app"
SWIFTBAR_SRC="$REPO_DIR/contrib/swiftbar/openswitch.10s.sh"

if [[ -d "$SWIFTBAR_APP" ]] || [[ -d "$HOME/Applications/SwiftBar.app" ]]; then
  if mkdir -p "$SWIFTBAR_PLUGIN_DIR" 2>/dev/null && \
     cp "$SWIFTBAR_SRC" "$SWIFTBAR_PLUGIN_DIR/openswitch.10s.sh" 2>/dev/null; then
    chmod +x "$SWIFTBAR_PLUGIN_DIR/openswitch.10s.sh"
    sed -i '' "s|^CREWSWARM_DIR=.*|CREWSWARM_DIR=\"$REPO_DIR\"|" \
      "$SWIFTBAR_PLUGIN_DIR/openswitch.10s.sh" 2>/dev/null || true
    success "SwiftBar plugin installed → menu bar status active"
  else
    warn "SwiftBar found but couldn't write plugin (permission issue?)"
    echo "    Manual install: cp contrib/swiftbar/openswitch.10s.sh \"$SWIFTBAR_PLUGIN_DIR/\""
  fi
else
  skip "SwiftBar not installed — skipping menu bar plugin"
  echo "    Install SwiftBar (free): https://swiftbar.app  then re-run install.sh"
fi

# ── 6b. CrewChat macOS app ────────────────────────────────────────────────────
if command -v swiftc &>/dev/null; then
  echo -n "  Build CrewChat.app (native macOS chat window)? [Y/n] "
  read -r BUILD_CHAT
  BUILD_CHAT="${BUILD_CHAT:-Y}"
  if [[ "$BUILD_CHAT" =~ ^[Yy] ]]; then
    mkdir -p "$HOME/bin"
    APP_DIR="$HOME/Applications/CrewChat.app"
    mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

    swiftc -framework AppKit -framework Foundation \
      -o "$APP_DIR/Contents/MacOS/CrewChat" \
      "$REPO_DIR/CrewChat.swift" 2>/dev/null
    chmod +x "$APP_DIR/Contents/MacOS/CrewChat"

    # Write minimal Info.plist
    cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CrewChat</string>
  <key>CFBundleIdentifier</key><string>ai.crewswarm.crewchat</string>
  <key>CFBundleName</key><string>CrewChat</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

    # Build icon if sips + iconutil available and favicon exists
    FAVICON="$REPO_DIR/website/favicon.png"
    if [[ -f "$FAVICON" ]] && command -v iconutil &>/dev/null; then
      ICONSET="/tmp/CrewChat.iconset"
      mkdir -p "$ICONSET"
      for SIZE in 16 32 64 128 256 512; do
        sips -z $SIZE $SIZE "$FAVICON" \
          --out "$ICONSET/icon_${SIZE}x${SIZE}.png" &>/dev/null || true
        sips -z $((SIZE*2)) $((SIZE*2)) "$FAVICON" \
          --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" &>/dev/null || true
      done
      iconutil -c icns "$ICONSET" \
        -o "$APP_DIR/Contents/Resources/CrewChat.icns" 2>/dev/null || true
    fi

    touch "$APP_DIR"
    success "CrewChat.app built → ~/Applications/CrewChat.app"
    echo "    Launch: open ~/Applications/CrewChat.app"
  else
    skip "Skipping CrewChat build"
  fi
else
  skip "Xcode Command Line Tools not found — skipping CrewChat build"
  echo "    Install CLT: xcode-select --install  then re-run install.sh"
fi

# ── 6c. Telegram bot ─────────────────────────────────────────────────────────
echo ""
echo -n "  Set up Telegram bot? [y/N] "
read -r SETUP_TG
SETUP_TG="${SETUP_TG:-N}"
if [[ "$SETUP_TG" =~ ^[Yy] ]]; then
  echo ""
  echo "  1. Open Telegram and message @BotFather → /newbot"
  echo "  2. Copy the token it gives you, paste below:"
  echo -n "  Bot token: "
  read -r TG_TOKEN
  if [[ -n "$TG_TOKEN" ]]; then
    # Add to .env if it exists, otherwise write one
    ENV_FILE="$REPO_DIR/.env"
    if [[ -f "$ENV_FILE" ]] && grep -q "TELEGRAM_BOT_TOKEN" "$ENV_FILE"; then
      sed -i '' "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG_TOKEN|" "$ENV_FILE"
    else
      echo "" >> "$ENV_FILE"
      echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN" >> "$ENV_FILE"
    fi
    success "Telegram token saved to .env"
    echo "    Start bridge: TELEGRAM_BOT_TOKEN=$TG_TOKEN npm run telegram"
  else
    skip "No token entered — skipping Telegram"
  fi
else
  skip "Skipping Telegram (add TELEGRAM_BOT_TOKEN=xxx to .env later)"
fi

# ── 6d. WhatsApp bridge ───────────────────────────────────────────────────────
echo ""
echo -n "  Set up WhatsApp bridge? [y/N] "
read -r SETUP_WA
SETUP_WA="${SETUP_WA:-N}"
if [[ "$SETUP_WA" =~ ^[Yy] ]]; then
  echo ""
  echo "  WhatsApp uses your personal number as a linked device (no business account needed)."
  echo -n "  Your WhatsApp number in international format (e.g. 14155552671), or leave blank to allow anyone: "
  read -r WA_NUMBER
  echo -n "  Your name (so the crew knows who you are, e.g. Jeff): "
  read -r WA_NAME

  WA_CFG="$CREWSWARM_DIR/whatsapp-bridge.json"
  if [[ -n "$WA_NUMBER" ]]; then
    ALLOWED_JSON="[\"$WA_NUMBER\"]"
    CONTACTS_JSON="{\"$WA_NUMBER\":\"${WA_NAME:-Owner}\"}"
  else
    ALLOWED_JSON="[]"
    CONTACTS_JSON="{}"
  fi

  cat > "$WA_CFG" <<EOF
{
  "allowedNumbers": $ALLOWED_JSON,
  "contactNames": $CONTACTS_JSON,
  "targetAgent": "crew-lead"
}
EOF
  success "WhatsApp config saved to ~/.crewswarm/whatsapp-bridge.json"
  echo "    Start bridge: npm run whatsapp"
  echo "    Then scan the QR code with WhatsApp → Linked Devices → Link a Device"
  echo "    Bridge runs on port 5015. Messages route to crew-lead automatically."
else
  skip "Skipping WhatsApp (run 'npm run whatsapp' later and scan QR to activate)"
fi

# ── 6e. Autonomous / background consciousness ─────────────────────────────────
echo ""
echo -n "  Enable autonomous mode? Crew-lead reflects between tasks and can self-initiate [y/N] "
read -r SETUP_AUTO
SETUP_AUTO="${SETUP_AUTO:-N}"
ENV_FILE="$REPO_DIR/.env"
if [[ "$SETUP_AUTO" =~ ^[Yy] ]]; then
  echo -n "  Check interval in minutes (default 15): "
  read -r AUTO_INTERVAL
  AUTO_INTERVAL="${AUTO_INTERVAL:-15}"
  AUTO_MS=$(( AUTO_INTERVAL * 60 * 1000 ))

  if [[ -f "$ENV_FILE" ]] && grep -q "CREWSWARM_BG_CONSCIOUSNESS" "$ENV_FILE"; then
    sed -i '' "s|^CREWSWARM_BG_CONSCIOUSNESS=.*|CREWSWARM_BG_CONSCIOUSNESS=1|" "$ENV_FILE"
    sed -i '' "s|^CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS=.*|CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS=$AUTO_MS|" "$ENV_FILE"
  else
    echo "" >> "$ENV_FILE"
    echo "CREWSWARM_BG_CONSCIOUSNESS=1" >> "$ENV_FILE"
    echo "CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS=$AUTO_MS" >> "$ENV_FILE"
  fi
  success "Autonomous mode enabled (every ${AUTO_INTERVAL}min) — saved to .env"
  echo "    crew-lead will reflect between tasks, suggest follow-ups, and monitor the crew."
else
  skip "Skipping autonomous mode (set CREWSWARM_BG_CONSCIOUSNESS=1 in .env to enable later)"
fi

# ── 6f. MCP integration (Cursor / Claude Code / OpenCode) ────────────────────
echo ""
echo -n "  Wire CrewSwarm agents into Cursor / Claude Code / OpenCode via MCP? [y/N] "
read -r SETUP_MCP
SETUP_MCP="${SETUP_MCP:-N}"
if [[ "$SETUP_MCP" =~ ^[Yy] ]]; then
  RT_TOKEN=$(node -e "try{const c=require('fs').readFileSync('$CREWSWARM_DIR/config.json','utf8');console.log(JSON.parse(c).rt?.authToken||'')}catch{}" 2>/dev/null)
  MCP_ENTRY=$(cat <<EOF
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer ${RT_TOKEN}"
      }
    }
  }
}
EOF
)

  # Cursor
  CURSOR_MCP="$HOME/.cursor/mcp.json"
  mkdir -p "$HOME/.cursor"
  if [[ -f "$CURSOR_MCP" ]]; then
    skip "Cursor mcp.json already exists — skipping (edit $CURSOR_MCP to add crewswarm manually)"
  else
    echo "$MCP_ENTRY" > "$CURSOR_MCP"
    success "Cursor MCP configured → $CURSOR_MCP (restart Cursor to activate)"
  fi

  # Claude Code
  CLAUDE_MCP="$HOME/.claude/mcp.json"
  mkdir -p "$HOME/.claude"
  if [[ -f "$CLAUDE_MCP" ]]; then
    skip "Claude Code mcp.json already exists — skipping (edit $CLAUDE_MCP to add crewswarm manually)"
  else
    echo "$MCP_ENTRY" > "$CLAUDE_MCP"
    success "Claude Code MCP configured → $CLAUDE_MCP"
  fi

  # OpenCode
  OPENCODE_MCP="$HOME/.config/opencode/mcp.json"
  mkdir -p "$HOME/.config/opencode"
  if [[ -f "$OPENCODE_MCP" ]]; then
    skip "OpenCode mcp.json already exists — skipping (edit $OPENCODE_MCP to add crewswarm manually)"
  else
    echo "$MCP_ENTRY" > "$OPENCODE_MCP"
    success "OpenCode MCP configured → $OPENCODE_MCP"
  fi

  echo ""
  echo "  Once configured, all 20 CrewSwarm agents are available as MCP tools in any project."
  echo "  MCP server runs on :5020 — start with: npm run restart-all"
else
  skip "Skipping MCP integration"
  echo "    To add later: see AGENTS.md → MCP Integration"
fi

# ── 7. Start now? ─────────────────────────────────────────────────────────────
header "7/7  Start CrewSwarm"
echo ""
echo -e "  ${BOLD}You need at least one API key to run agents.${RESET}"
echo "  Groq is free → https://console.groq.com  (takes 30 seconds)"
echo ""

HAS_KEY=0
if grep -qE '"apiKey":\s*"[^"]{8,}"' "$CONFIG_FILE" 2>/dev/null; then
  HAS_KEY=1
fi

if [[ "$HAS_KEY" -eq 0 ]]; then
  warn "No API key found yet in ~/.crewswarm/config.json"
  echo "  You can start now and add a key in the dashboard → Providers tab."
  echo ""
fi

echo -n "  Start CrewSwarm now? [Y/n] "
read -r START_NOW
START_NOW="${START_NOW:-Y}"

if [[ "$START_NOW" =~ ^[Yy] ]]; then
  echo ""
  info "Starting CrewSwarm..."
  bash "$REPO_DIR/scripts/restart-all-from-repo.sh" > /dev/null 2>&1 &

  echo ""
  info "Waiting for services..."
  echo ""

  wait_for() {
    local label="$1" url="$2" timeout=30 elapsed=0
    printf "  %-22s" "$label"
    while ! curl -sf "$url" > /dev/null 2>&1; do
      sleep 1; elapsed=$((elapsed + 1))
      [[ $elapsed -ge $timeout ]] && { echo -e "${RED}✗ timed out${RESET}"; return 1; }
    done
    echo -e "${GREEN}✓ up${RESET}  (${elapsed}s)"
  }

  wait_for_port() {
    local label="$1" port="$2" timeout=30 elapsed=0
    printf "  %-22s" "$label"
    while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
      sleep 1; elapsed=$((elapsed + 1))
      [[ $elapsed -ge $timeout ]] && { echo -e "${RED}✗ timed out${RESET}"; return 1; }
    done
    echo -e "${GREEN}✓ up${RESET}  (${elapsed}s)"
  }

  wait_for_port "RT bus  :18889"   18889
  wait_for      "crew-lead :5010"  "http://127.0.0.1:5010/health"
  wait_for      "Dashboard :4319"  "http://127.0.0.1:4319"
  wait_for      "MCP/OpenAI :5020" "http://127.0.0.1:5020/health"

  BRIDGE_COUNT=$(pgrep -f "gateway-bridge.mjs" 2>/dev/null | wc -l | tr -d ' ')
  printf "  %-22s" "Agent bridges"
  if [[ "$BRIDGE_COUNT" -gt 0 ]]; then
    echo -e "${GREEN}✓ $BRIDGE_COUNT running${RESET}"
  else
    echo -e "${YELLOW}⚠ none detected yet${RESET}"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}CrewSwarm is running!${RESET}"
  echo ""

  if [[ "$HAS_KEY" -eq 0 ]]; then
    echo -e "  ${YELLOW}${BOLD}Add an API key in Providers tab before chatting.${RESET}"
    echo ""
  fi

  echo "  Opening dashboard..."
  sleep 1
  open "http://127.0.0.1:4319" 2>/dev/null || true
  echo ""
  echo "  Logs: /tmp/opencrew-rt-daemon.log  /tmp/crew-lead.log  /tmp/dashboard.log  /tmp/crewswarm-mcp.log"
  echo "  Restart later: cd $REPO_DIR && npm run restart-all"
  echo ""
  echo "  OpenAI-compatible API (Open WebUI, LM Studio, Aider, etc.):"
  echo "    Base URL: http://127.0.0.1:5020/v1   API key: (any string)"
  echo "    Models:   http://127.0.0.1:5020/v1/models  (one per agent)"
  echo ""
else
  echo ""
  echo "  When ready:  cd $REPO_DIR && npm run restart-all"
  echo "  Then open:   http://127.0.0.1:4319"
  echo ""
fi
