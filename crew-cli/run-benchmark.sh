#!/bin/bash

# API Keys
# Set provider keys in your shell before running benchmarks. Do not hardcode secrets here.
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY before running benchmarks}"
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY before running benchmarks}"
: "${GOOGLE_API_KEY:=$GEMINI_API_KEY}"

# Model Configuration (GPT-5.2 for L2, Gemini for L3)
export CREW_L2A_MODEL="gpt-5.2"
export CREW_L2B_MODEL="gpt-5.2"
export CREW_REASONING_MODEL="gpt-5.2"
export CREW_JSON_REPAIR_MODEL="gpt-5.2"
export CREW_EXECUTION_MODEL="gemini-2.5-flash"

# Enable Dual-L2
export CREW_DUAL_L2_ENABLED=true

# Run benchmark
cd "$(dirname "$0")"
npm run benchmark:presets -- "$@"
