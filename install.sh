#!/usr/bin/env bash
# CrewSwarm — first-time install script for macOS
# Usage: bash install.sh
# Or via curl: bash <(curl -fsSL https://raw.githubusercontent.com/CrewSwarm/CrewSwarm/main/install.sh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREWSWARM_DIR="$HOME/.crewswarm"
OPENCLAW_DIR="$HOME/.openclaw"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▶${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*"; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

header "╔════════════════════════════════╗"
header "║     CrewSwarm  Installer       ║"
header "╚════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
header "1/5  Checking prerequisites"

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
header "2/5  Installing dependencies"
cd "$REPO_DIR"
npm install --silent
success "npm packages installed"

# ── 3. Create config directories ─────────────────────────────────────────────
header "3/5  Setting up config directories"

mkdir -p "$CREWSWARM_DIR"
mkdir -p "$OPENCLAW_DIR"
mkdir -p "$CREWSWARM_DIR/chat-history"
success "Created ~/.crewswarm  and  ~/.openclaw"

# ── 4. Bootstrap config files ────────────────────────────────────────────────
header "4/5  Bootstrapping config files"

# ~/.crewswarm/config.json  (API keys + RT token)
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

# ~/.openclaw/openclaw.json  (agent list + models)
OPENCLAW_CFG="$OPENCLAW_DIR/openclaw.json"
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

# ~/.crewswarm/cmd-allowlist.json
ALLOWLIST="$CREWSWARM_DIR/cmd-allowlist.json"
if [[ ! -f "$ALLOWLIST" ]]; then
  echo '{"patterns":["npm *","node *","npx *"]}' > "$ALLOWLIST"
  success "Created ~/.crewswarm/cmd-allowlist.json  (npm, node, npx pre-approved)"
fi

# ~/.crewswarm/token-usage.json
TOKEN_FILE="$CREWSWARM_DIR/token-usage.json"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo '{"calls":0,"promptTokens":0,"completionTokens":0,"totalTokens":0,"estimatedCostUSD":0,"byModel":{}}' > "$TOKEN_FILE"
fi

# ── 5. Optional: add crew-cli to PATH ────────────────────────────────────────
header "5/5  Finishing up"

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
  success "crew-cli alias already set (or shell not detected)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  ${BOLD}Next step: add your API key${RESET}"
echo "  Open the dashboard → Providers tab and paste a Groq key (free at console.groq.com)"
echo "  Or edit ~/.crewswarm/config.json directly."
echo ""
echo -e "  ${BOLD}Start the crew:${RESET}"
echo "    cd $REPO_DIR"
echo "    npm run restart-all"
echo ""
echo -e "  ${BOLD}Then open:${RESET}  http://127.0.0.1:4319  (Chat tab)"
echo ""
echo -e "  ${BOLD}Or from terminal:${RESET}"
echo "    crew-cli \"Build a REST API with tests\""
echo ""
echo "  Logs: /tmp/opencrew-rt-daemon.log  /tmp/crew-lead.log  /tmp/dashboard.log"
echo ""
