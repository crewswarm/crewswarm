#!/usr/bin/env bash
# Lightweight public-release checklist runner.
#
# Usage:
#   bash scripts/release-check.sh
#   bash scripts/release-check.sh --full

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

FULL=0
for arg in "$@"; do
  [[ "$arg" == "--full" ]] && FULL=1
done

echo ""
echo "━━━ crewswarm release check ━━━"
echo "repo: $REPO_DIR"
echo "date: $(date)"

echo ""
echo "1. Doctor"
npm run doctor

echo ""
echo "2. Static smoke"
bash scripts/smoke.sh --no-build

echo ""
echo "3. Health"
if [[ "${CI:-}" == "true" ]]; then
  npm run health -- --quiet --no-services
else
  npm run health -- --quiet
fi

if [[ "$FULL" -eq 1 ]]; then
  echo ""
  echo "4. Live dispatch smoke"
  npm run smoke
fi

echo ""
echo "Release check passed."
