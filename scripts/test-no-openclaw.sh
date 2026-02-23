#!/usr/bin/env bash
# Test CrewSwarm with no ~/.openclaw (crewswarm-only config).
# Temporarily renames ~/.openclaw to ~/.openclaw.bak, runs checks, then restores.
# Prereq: ~/.crewswarm must exist with crewswarm.json (and ideally config.json).
# Usage: bash scripts/test-no-openclaw.sh [--keep]   # --keep = leave openclaw hidden (don't restore)

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREWSWARM_DIR="${CREWSWARM_DIR:-$REPO}"
OPENCLAW_HOME="${HOME}/.openclaw"
OPENCLAW_BAK="${HOME}/.openclaw.bak"
RESTORE=1
for a in "$@"; do [[ "$a" == "--keep" ]] && RESTORE=0; done

if [[ ! -f "$HOME/.crewswarm/crewswarm.json" ]]; then
  echo "Missing $HOME/.crewswarm/crewswarm.json — run install.sh or create config first."
  exit 1
fi

# Hide .openclaw if present
if [[ -d "$OPENCLAW_HOME" ]] || [[ -f "$OPENCLAW_HOME" ]]; then
  echo "Temporarily moving $OPENCLAW_HOME to $OPENCLAW_BAK"
  rm -rf "$OPENCLAW_BAK"
  mv "$OPENCLAW_HOME" "$OPENCLAW_BAK"
  HIDDEN=1
else
  echo "No $OPENCLAW_HOME — already testing without OpenClaw."
  HIDDEN=0
fi

restore_openclaw() {
  if [[ "$HIDDEN" -eq 1 ]] && [[ -d "$OPENCLAW_BAK" ]] || [[ -f "$OPENCLAW_BAK" ]]; then
    echo "Restoring $OPENCLAW_BAK to $OPENCLAW_HOME"
    rm -rf "$OPENCLAW_HOME"
    mv "$OPENCLAW_BAK" "$OPENCLAW_HOME"
  fi
}

trap '[[ "$RESTORE" -eq 1 ]] && restore_openclaw' EXIT

echo "--- 1. Config check (crewswarm-test --quick) ---"
cd "$CREWSWARM_DIR"
node scripts/crewswarm-test.mjs --quick 2>&1 | head -50
CODE1=${PIPESTATUS[0]}

echo ""
echo "--- 2. openswitchctl status ---"
bash scripts/openswitchctl status 2>&1
CODE2=$?

echo ""
echo "--- 3. start-crew --status ---"
node scripts/start-crew.mjs --status 2>&1
CODE3=$?

echo ""
echo "--- 4. crew-cli --status ---"
node crew-cli.mjs --status 2>&1
CODE4=$?

echo ""
echo "--- Summary ---"
[[ "$CODE1" -eq 0 ]] && echo "crewswarm-test: OK" || echo "crewswarm-test: exit $CODE1 (may be due to services not running)"
[[ "$CODE2" -eq 0 ]] && echo "openswitchctl:  OK" || echo "openswitchctl:  exit $CODE2"
[[ "$CODE3" -eq 0 ]] && echo "start-crew:     OK" || echo "start-crew:     exit $CODE3"
[[ "$CODE4" -eq 0 ]] && echo "crew-cli:       OK" || echo "crew-cli:       exit $CODE4"

if [[ "$RESTORE" -eq 1 ]]; then
  restore_openclaw
  trap - EXIT
  echo ""
  echo "Done. OpenClaw restored."
else
  echo ""
  echo "Done. OpenClaw left at $OPENCLAW_BAK (restore with: mv $OPENCLAW_BAK $OPENCLAW_HOME)"
fi
