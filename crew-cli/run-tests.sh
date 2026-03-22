#!/bin/bash
# Quick test runner for crew-cli standalone verification

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
RESET='\033[0m'

echo -e "${BLUE}════════════════════════════════════════════════════════════════${RESET}"
echo -e "${BLUE}     CREW-CLI STANDALONE TEST RUNNER${RESET}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${RESET}\n"

# Change to crew-cli directory
cd "$(dirname "$0")"

# Check if built
if [ ! -f "dist/crew.mjs" ]; then
  echo -e "${YELLOW}⚠️  Build not found. Running build...${RESET}"
  npm run build
  echo -e "${GREEN}✅ Build complete${RESET}\n"
fi

# Parse arguments
MODE="verify"
if [ "$1" = "--full" ]; then
  MODE="full"
elif [ "$1" = "--quick" ]; then
  MODE="quick"
elif [ "$1" = "--help" ]; then
  echo "Usage: ./run-tests.sh [--verify|--quick|--full]"
  echo ""
  echo "Modes:"
  echo "  --verify  (default) Run verification checks only"
  echo "  --quick   Run focused sandbox + tools test"
  echo "  --full    Run comprehensive integration test suite"
  echo ""
  echo "Examples:"
  echo "  ./run-tests.sh              # Verification only"
  echo "  ./run-tests.sh --quick      # Quick test (~1 min)"
  echo "  ./run-tests.sh --full       # Full test (~5 min)"
  exit 0
fi

case $MODE in
  verify)
    echo -e "${BLUE}Running verification checks...${RESET}\n"
    node verify-standalone.mjs
    ;;
  
  quick)
    echo -e "${BLUE}Running quick sandbox + tools test...${RESET}\n"
    node verify-standalone.mjs
    if [ $? -eq 0 ]; then
      echo -e "\n${BLUE}Verification passed. Running sandbox test...${RESET}\n"
      node test-sandbox-tools.mjs
    else
      echo -e "${RED}❌ Verification failed. Fix issues before running tests.${RESET}"
      exit 1
    fi
    ;;
  
  full)
    echo -e "${BLUE}Running full test suite...${RESET}\n"
    node verify-standalone.mjs
    if [ $? -eq 0 ]; then
      echo -e "\n${BLUE}Verification passed. Running comprehensive tests...${RESET}\n"
      node test-standalone-complete.mjs
    else
      echo -e "${RED}❌ Verification failed. Fix issues before running tests.${RESET}"
      exit 1
    fi
    ;;
esac

if [ $? -eq 0 ]; then
  echo -e "\n${GREEN}════════════════════════════════════════════════════════════════${RESET}"
  echo -e "${GREEN}    ✅ ALL TESTS PASSED${RESET}"
  echo -e "${GREEN}════════════════════════════════════════════════════════════════${RESET}\n"
else
  echo -e "\n${RED}════════════════════════════════════════════════════════════════${RESET}"
  echo -e "${RED}    ❌ TESTS FAILED${RESET}"
  echo -e "${RED}════════════════════════════════════════════════════════════════${RESET}\n"
  exit 1
fi
