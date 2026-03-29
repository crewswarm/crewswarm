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

flyctl deploy --remote-only -c "$SCRIPT_DIR/fly.toml"

echo ""
echo "✅ Deployment complete!"
echo "🌐 Live at: https://crewswarm.fly.dev/"
echo "🌐 Production: https://crewswarm.ai/"
