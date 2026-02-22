#!/usr/bin/env bash
# CrewSwarm — first-time install script for macOS
# Usage: bash install.sh
# Or via curl: bash <(curl -fsSL https://raw.githubusercontent.com/CrewSwarm/CrewSwarm/main/install.sh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREWSWARM_DIR="$HOME/.crewswarm"
OPENCLAW_DIR_CFG="$HOME/.openclaw"

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
mkdir -p "$OPENCLAW_DIR_CFG"
mkdir -p "$CREWSWARM_DIR/chat-history"
success "Created ~/.crewswarm  and  ~/.openclaw"

# ── 4. Bootstrap config files ────────────────────────────────────────────────
header "4/7  Bootstrapping config files"

CONFIG_FILE="$CREWSWARM_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  RT_TOKEN="crewswarm-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 16)"
  cat > "$CONFIG_FILE" <<EOF
{
  "providers": {
    "groq":      { "apiKey": "", "baseUrl": "https://api.groq.com/openai/v1" },
    "anthropic": { "apiKey": "", "baseUrl": "https://api.anthropic.com/v1" },
    "openai":    { "apiKey": "", "baseUrl": "https://api.openai.com/v1" },
    "mistral":   { "apiKey": "", "baseUrl": "https://api.mistral.ai/v1" },
    "ollama":    { "apiKey": "", "baseUrl": "http://localhost:11434/v1" }
  },
  "rt": {
    "authToken": "$RT_TOKEN"
  }
}
EOF
  success "Created ~/.crewswarm/config.json  (RT token: $RT_TOKEN)"
else
  success "~/.crewswarm/config.json already exists — keeping it"
fi

OPENCLAW_CFG="$OPENCLAW_DIR_CFG/openclaw.json"
if [[ ! -f "$OPENCLAW_CFG" ]]; then
  cat > "$OPENCLAW_CFG" <<'EOF'
{
  "agents": [
    { "id": "crew-main",         "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-pm",           "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-coder",        "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-coder-front",  "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-coder-back",   "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-qa",           "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-fixer",        "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-security",     "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-github",       "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-copywriter",   "model": "groq/llama-3.3-70b-versatile" }
  ]
}
EOF
  success "Created ~/.openclaw/openclaw.json  (all agents using Groq Llama 3.3 70B)"
else
  success "~/.openclaw/openclaw.json already exists — keeping it"
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
    sed -i '' "s|^OPENCLAW_DIR=.*|OPENCLAW_DIR=\"$REPO_DIR\"|" \
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
  echo "  Logs: /tmp/opencrew-rt-daemon.log  /tmp/crew-lead.log  /tmp/dashboard.log"
  echo "  Restart later: cd $REPO_DIR && npm run restart-all"
  echo ""
else
  echo ""
  echo "  When ready:  cd $REPO_DIR && npm run restart-all"
  echo "  Then open:   http://127.0.0.1:4319"
  echo ""
fi
