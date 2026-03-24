#!/bin/bash
set -e

echo "🚀 Deploying crewswarm website with new screenshots..."
echo ""

cd /Users/jeffhobbs/CrewSwarm/website

# Check auth
if ! flyctl auth whoami &>/dev/null; then
  echo "❌ Not authenticated with Fly.io"
  echo "Please run: flyctl auth login"
  exit 1
fi

echo "✅ Authenticated with Fly.io"
echo ""
echo "📦 Building and deploying..."
echo ""

flyctl deploy --remote-only

echo ""
echo "✅ Deployment complete!"
echo "🌐 Live at: https://crewswarm.fly.dev/"
echo "🌐 Production: https://crewswarm.ai/"
