#!/bin/bash
# Quick start script for crewswarm Studio

set -e

cd "$(dirname "$0")/apps/vibe"

echo "🐝 crewswarm Studio Setup"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

echo "🚀 Starting Studio in dev mode..."
echo ""
echo "   Open: http://127.0.0.1:3333"
echo ""
echo "   Press Ctrl+C to stop"
echo ""

npm run dev
