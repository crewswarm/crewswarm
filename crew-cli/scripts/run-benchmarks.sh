#!/bin/bash
# Complete Benchmark & Test Suite
# Tests both direct LLMs and 3-tier stack

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           CREWSWARM STACK BENCHMARK SUITE                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check environment
echo "🔍 Checking environment..."

missing=0
warnings=""

if [ -z "$XAI_API_KEY" ]; then
  warnings="${warnings}  ⚠️  XAI_API_KEY not set (Grok/x.ai tests will be skipped)\n"
  missing=$((missing + 1))
fi

if [ -z "$GEMINI_API_KEY" ]; then
  warnings="${warnings}  ⚠️  GEMINI_API_KEY not set (Gemini tests will be skipped)\n"
  missing=$((missing + 1))
fi

if [ -z "$DEEPSEEK_API_KEY" ]; then
  warnings="${warnings}  ⚠️  DEEPSEEK_API_KEY not set (DeepSeek tests will be skipped)\n"
  missing=$((missing + 1))
fi

if [ -z "$GROQ_API_KEY" ]; then
  warnings="${warnings}  ⚠️  GROQ_API_KEY not set (Groq tests will be skipped)\n"
  missing=$((missing + 1))
fi

if [ -z "$OPENCODE_API_KEY" ]; then
  warnings="${warnings}  ⚠️  OPENCODE_API_KEY not set (OpenCode tests will be skipped)\n"
  missing=$((missing + 1))
fi

if [ $missing -eq 5 ]; then
  echo ""
  echo "❌ No API keys configured. Set at least one:"
  echo "   export XAI_API_KEY='your-key'"
  echo "   export GEMINI_API_KEY='your-key'"
  echo "   export DEEPSEEK_API_KEY='your-key'"
  echo "   export GROQ_API_KEY='your-key'"
  echo "   export OPENCODE_API_KEY='your-key'"
  echo ""
  echo "💡 Or use the config loader:"
  echo "   node scripts/test-with-config.mjs"
  echo ""
  exit 1
fi

if [ $missing -gt 0 ]; then
  echo -e "$warnings"
  echo "  ℹ️  Tests will run with available providers only"
  echo ""
  echo "💡 TIP: Use test-with-config.mjs to auto-load keys from ~/.crewswarm/crewswarm.json"
  echo "   node scripts/test-with-config.mjs"
  echo ""
else
  echo "  ✓ All API keys configured"
fi
echo ""

# Build CLI
echo "🔨 Building CLI..."
cd crew-cli
npm run build > /dev/null 2>&1 || {
  echo "❌ Build failed. Run 'npm run build' manually to see errors."
  exit 1
}
echo "  ✓ Build complete"
echo ""

# Test 1: Direct LLM baseline
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TEST 1: Direct LLM Baseline (No Pipeline)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node scripts/test-direct-llm.mjs

echo ""
echo "Press Enter to continue to 3-Tier Stack tests..."
read

# Test 2: 3-Tier Stack benchmark
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TEST 2: 3-Tier Stack Benchmark"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node scripts/benchmark-stack.mjs

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "ALL TESTS COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Quick benchmark (auto-loads keys from crewswarm.json):"
echo "   node scripts/test-with-config.mjs"

