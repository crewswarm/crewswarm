#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "crew-cli installer"
echo "Project: $ROOT_DIR"
echo

check_cmd() {
  local cmd="$1"
  local label="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "✓ $label"
    return 0
  fi

  echo "✗ $label"
  return 1
}

NODE_OK=0
if check_cmd node "Node.js installed"; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    echo "✓ Node.js version >= 20 ($(node -v))"
    NODE_OK=1
  else
    echo "✗ Node.js version must be >= 20 (found $(node -v))"
  fi
fi

GIT_OK=0
if check_cmd git "Git installed"; then
  GIT_OK=1
fi

echo
echo "Checking optional CLIs"
check_cmd aider "Aider CLI installed" || true
check_cmd gemini "Gemini CLI installed" || true
check_cmd codex "Codex CLI installed" || true
check_cmd claude "Claude Code CLI installed" || true

echo
echo "Installing npm dependencies"
npm install

echo
echo "Running diagnostics"
if node bin/crew.js doctor; then
  echo "✓ crew doctor passed"
else
  echo "✗ crew doctor reported issues"
fi

echo
echo "Installer completed."
if [[ "$NODE_OK" -ne 1 || "$GIT_OK" -ne 1 ]]; then
  echo "Required prerequisites are missing. Fix the failed checks above."
  exit 1
fi
