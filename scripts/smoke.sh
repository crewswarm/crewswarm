#!/usr/bin/env bash
# crewswarm smoke tests — fast pre-push checks, no running services required.
#
# Usage:
#   bash scripts/smoke.sh              # full local run
#   bash scripts/smoke.sh --no-build   # skip frontend build (faster re-runs)
#   CI=true bash scripts/smoke.sh      # same flags used in GitHub Actions
#
# Exit codes: 0 = all pass, 1 = one or more failures

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

NO_BUILD="${NO_BUILD:-}"
for arg in "$@"; do
  [[ "$arg" == "--no-build" ]] && NO_BUILD=1
done

# ── colour helpers ────────────────────────────────────────────────────────────
if [[ -t 1 ]] && command -v tput &>/dev/null; then
  G="$(tput setaf 2)" R="$(tput setaf 1)" Y="$(tput setaf 3)" B="$(tput bold)" X="$(tput sgr0)"
else
  G="" R="" Y="" B="" X=""
fi

PASS=0; FAIL=0

ok()   { echo "  ${G}✓${X} $1"; ((PASS++)) || true; }
fail() { echo "  ${R}✗${X} $1"; ((FAIL++)) || true; }
info() { echo ""; echo "${B}── $1 ──${X}"; }

echo ""
echo "${B}━━━ crewswarm Smoke Tests ━━━${X}"
echo "  repo: $REPO_DIR"
echo "  $(date)"

# ── 1. Node version ──────────────────────────────────────────────────────────
info "Node"
NODE_VER=$(node --version 2>/dev/null || echo "missing")
MAJOR=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [[ "$NODE_VER" == "missing" ]]; then
  fail "node not found"
elif [[ "${MAJOR:-0}" -lt 20 ]]; then
  fail "node $NODE_VER — need >=20"
else
  ok "node $NODE_VER"
fi

# ── 2. Dependencies installed ────────────────────────────────────────────────
info "Dependencies"
if [[ -d node_modules ]]; then
  ok "node_modules present"
else
  fail "node_modules missing — run: npm ci"
fi

if [[ -d apps/dashboard/node_modules ]]; then
  ok "apps/dashboard/node_modules present"
else
  fail "apps/dashboard/node_modules missing — run: cd apps/dashboard && npm ci"
fi

# ── 3. Syntax checks ─────────────────────────────────────────────────────────
info "Syntax"
for f in crew-lead.mjs gateway-bridge.mjs scripts/dashboard.mjs; do
  if node --check "$f" 2>/dev/null; then
    ok "$f"
  else
    fail "$f  (syntax error)"
  fi
done

# New lib modules
LIB_ERRORS=0
for f in $(find lib -name "*.mjs" 2>/dev/null); do
  if ! node --check "$f" 2>/dev/null; then
    fail "$f  (syntax error)"
    ((LIB_ERRORS++)) || true
  fi
done
[[ "$LIB_ERRORS" -eq 0 ]] && ok "lib/**/*.mjs ($(find lib -name '*.mjs' | wc -l | tr -d ' ') files)"

# ── 4. Frontend build ────────────────────────────────────────────────────────
info "Frontend build"
if [[ -n "$NO_BUILD" ]]; then
  echo "  ${Y}skipped${X} (--no-build)"
else
  if cd apps/dashboard && npm run build --silent 2>&1 | tail -3 && cd "$REPO_DIR"; then
    ok "vite build"
  else
    cd "$REPO_DIR"
    fail "vite build failed"
  fi
fi

# Check dist exists regardless
if [[ -f apps/dashboard/dist/index.html ]]; then
  ok "apps/dashboard/dist/index.html exists"
else
  fail "apps/dashboard/dist/index.html missing — run: cd apps/dashboard && npm run build"
fi

# ── 5. Dashboard source check + telemetry schema validation ──────────────────
info "Dashboard"
if node scripts/check-dashboard.mjs --source-only 2>&1 | grep -q "passed"; then
  ok "check-dashboard --source-only"
else
  fail "check-dashboard --source-only"
fi

if node scripts/check-dashboard.mjs --schema-only 2>&1 | grep -q "passed"; then
  ok "telemetry schema validation"
else
  fail "telemetry schema validation"
fi

# ── 6. Config bootstrap ──────────────────────────────────────────────────────
info "Config"
if [[ -f "$HOME/.crewswarm/config.json" ]]; then
  ok "~/.crewswarm/config.json"
else
  fail "~/.crewswarm/config.json missing — run: bash install.sh"
fi

if [[ -f "$HOME/.crewswarm/crewswarm.json" ]]; then
  ok "~/.crewswarm/crewswarm.json"
else
  fail "~/.crewswarm/crewswarm.json missing — run: bash install.sh"
fi

# ── 7. Static health check (no services) ────────────────────────────────────
info "Static health check"
if node scripts/health-check.mjs --no-services --quiet 2>&1; then
  ok "health-check --no-services"
else
  fail "health-check --no-services (see above)"
fi

# ── 8. Unit test suite ─────────────────────────────────────────────────────
info "Test suite"
TEST_OUTPUT="$(CREWSWARM_TEST_MODE=true node --test test/unit/*.test.mjs 2>&1)" || true
TEST_TOTAL="$(printf '%s\n' "$TEST_OUTPUT" | sed -n 's/^ℹ tests \([0-9][0-9]*\)$/\1/p' | tail -1)"
if printf '%s\n' "$TEST_OUTPUT" | grep -q "fail 0"; then
  ok "unit tests (${TEST_TOTAL:-unknown} tests)"
else
  printf '%s\n' "$TEST_OUTPUT"
  fail "test suite (see above)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "${B}━━━ Results ━━━${X}  ${G}${PASS} pass${X}  $([ "$FAIL" -gt 0 ] && echo "${R}" || echo "")${FAIL} fail${X}"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "${R}Smoke tests failed.${X} Fix the issues above and re-run."
  exit 1
else
  echo "${G}All smoke tests passed.${X}"
  exit 0
fi
