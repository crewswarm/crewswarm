#!/bin/bash
set -euo pipefail

echo "🚀 Deploying crewswarm website with new screenshots..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check auth
if ! flyctl auth whoami &>/dev/null; then
  echo "❌ Not authenticated with Fly.io"
  echo "Please run: flyctl auth login"
  exit 1
fi

echo "✅ Authenticated with Fly.io"
echo ""
echo "📦 Building and deploying from: $SCRIPT_DIR"
echo ""

DOCKER_DESKTOP_SOCKET="$HOME/.docker/run/docker.sock"

if [ -S "$DOCKER_DESKTOP_SOCKET" ]; then
  echo "🐳 Using Docker Desktop socket: $DOCKER_DESKTOP_SOCKET"
  echo ""
  DOCKER_HOST="unix://$DOCKER_DESKTOP_SOCKET" flyctl deploy --local-only -c "$SCRIPT_DIR/fly.toml"
else
  echo "⚠️ Docker Desktop socket not found, falling back to Fly remote builder"
  echo ""
  flyctl deploy --remote-only -c "$SCRIPT_DIR/fly.toml"
fi

echo ""
echo "✅ Deployment complete!"
echo "🌐 Live at: https://crewswarm.fly.dev/"
echo "🌐 Production: https://crewswarm.ai/"
