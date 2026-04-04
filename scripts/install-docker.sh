#!/usr/bin/env bash
# crewswarm Docker Installer — one-line setup for cloud VMs and dedicated servers
# Usage: curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash

set -e

CREWSWARM_VERSION="${CREWSWARM_VERSION:-latest}"
CREWSWARM_CONFIG_DIR="${HOME}/.crewswarm"
INSTALL_DIR="${CREWSWARM_INSTALL_DIR:-${HOME}/crewswarm}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  crewswarm Docker Installer"
echo "  Version: ${CREWSWARM_VERSION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Detect OS ─────────────────────────────────────────────────────────────────
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID}"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
echo "✓ Detected OS: ${OS}"

# ── Check Docker ──────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo ""
  echo "⚠️  Docker not found. Installing Docker..."
  
  case "${OS}" in
    ubuntu|debian)
      sudo apt-get update -qq
      sudo apt-get install -y ca-certificates curl gnupg lsb-release
      sudo mkdir -p /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/${OS}/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS} $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
      sudo apt-get update -qq
      sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      sudo systemctl enable docker
      sudo systemctl start docker
      sudo usermod -aG docker ${USER}
      ;;
    
    fedora|centos|rhel)
      sudo dnf -y install dnf-plugins-core
      sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
      sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      sudo systemctl enable docker
      sudo systemctl start docker
      sudo usermod -aG docker ${USER}
      ;;
    
    macos)
      echo ""
      echo "Please install Docker Desktop from:"
      echo "  https://www.docker.com/products/docker-desktop"
      echo ""
      echo "After installing, re-run this script."
      exit 1
      ;;
    
    *)
      echo "Unsupported OS: ${OS}"
      echo "Please install Docker manually: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
  
  echo "✓ Docker installed"
  echo ""
  echo "⚠️  You've been added to the 'docker' group."
  echo "    Log out and back in for it to take effect, then re-run this script."
  exit 0
else
  echo "✓ Docker already installed ($(docker --version))"
fi

# ── Check Docker Compose ──────────────────────────────────────────────────────
if ! docker compose version &>/dev/null; then
  echo "⚠️  Docker Compose plugin not found. Installing..."
  
  case "${OS}" in
    ubuntu|debian|fedora|centos|rhel)
      sudo apt-get install -y docker-compose-plugin 2>/dev/null || sudo dnf install -y docker-compose-plugin 2>/dev/null
      ;;
    macos)
      echo "Docker Compose should come with Docker Desktop. Please reinstall Docker Desktop."
      exit 1
      ;;
    *)
      echo "Please install Docker Compose manually: https://docs.docker.com/compose/install/"
      exit 1
      ;;
  esac
fi

echo "✓ Docker Compose available ($(docker compose version))"
echo ""

# ── Clone or update crewswarm repo ────────────────────────────────────────────
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "✓ crewswarm already cloned at ${INSTALL_DIR}"
  echo "  Updating to latest..."
  cd "${INSTALL_DIR}"
  git pull -q
else
  echo "Cloning crewswarm repository..."
  git clone https://github.com/crewswarm/crewswarm.git "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

echo "✓ Repository ready at ${INSTALL_DIR}"
echo ""

# ── Initialize config directory ───────────────────────────────────────────────
if [[ ! -d "${CREWSWARM_CONFIG_DIR}" ]]; then
  echo "Creating config directory at ${CREWSWARM_CONFIG_DIR}..."
  mkdir -p "${CREWSWARM_CONFIG_DIR}"
  
  # Bootstrap minimal config
  cat > "${CREWSWARM_CONFIG_DIR}/crewswarm.json" <<'EOF'
{
  "agents": [
    { "id": "crew-main", "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-coder", "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-pm", "model": "groq/llama-3.3-70b-versatile" }
  ],
  "providers": {},
  "env": {}
}
EOF
  
  # Generate RT auth token
  RT_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)
  cat > "${CREWSWARM_CONFIG_DIR}/config.json" <<EOF
{
  "rt": {
    "authToken": "${RT_TOKEN}"
  }
}
EOF
  
  # Create empty allowlist
  echo '{"allowed": []}' > "${CREWSWARM_CONFIG_DIR}/cmd-allowlist.json"
  
  echo "✓ Config directory initialized"
else
  echo "✓ Config directory already exists at ${CREWSWARM_CONFIG_DIR}"
fi

echo ""

# ── Pull/build Docker image ───────────────────────────────────────────────────
echo "Building crewswarm Docker image (this may take a few minutes)..."
docker compose build --quiet 2>&1 | grep -v "^#" || true
echo "✓ Docker image built"
echo ""

# ── Start services ────────────────────────────────────────────────────────────
echo "Starting crewswarm services..."
docker compose up -d

# Wait for health check
echo ""
echo "Waiting for services to become healthy..."
for i in {1..30}; do
  if curl -sf http://localhost:4319/api/health >/dev/null 2>&1; then
    echo "✓ Services are healthy"
    break
  fi
  sleep 2
  echo -n "."
done

echo ""
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎉 crewswarm is now running!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Dashboard:   http://localhost:4319"
echo "  crew-lead:   http://localhost:5010"
echo "  MCP server:  http://localhost:5020"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo ""
echo "  1. Open dashboard and add an API key (Providers tab)"
echo "     → Groq is free: https://console.groq.com/keys"
echo ""
echo "  2. Start chatting with your crew (Chat tab)"
echo ""
echo "  3. Test the crew CLI:"
echo "     $ docker compose exec crewswarm crew --version"
echo "     $ docker compose exec crewswarm crew doctor"
echo ""
echo "Useful commands:"
echo ""
echo "  View logs:    docker compose logs -f"
echo "  Stop:         docker compose down"
echo "  Restart:      docker compose restart"
echo "  Update:       cd ${INSTALL_DIR} && git pull && docker compose up -d --build"
echo ""
echo "Documentation: ${INSTALL_DIR}/docs/docker.md"
echo ""
