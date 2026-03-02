#!/bin/bash
# Multi-AI Code Review System
# Runs 3 AI reviewers (Codex, Gemini, Claude) on every PR
# Posts comments directly on GitHub

set -e

PR_NUMBER="$1"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[review]${NC} $1"; }
warn() { echo -e "${YELLOW}[review]${NC} $1"; }
error() { echo -e "${RED}[review]${NC} $1"; }
info() { echo -e "${BLUE}[review]${NC} $1"; }

if [ -z "$PR_NUMBER" ]; then
  error "Usage: multi-ai-review.sh <pr_number>"
  exit 1
fi

log "Starting multi-AI code review for PR #$PR_NUMBER"

# Get PR details
PR_JSON=$(gh pr view "$PR_NUMBER" --json title,body,files,additions,deletions)
PR_TITLE=$(echo "$PR_JSON" | jq -r '.title')
PR_BODY=$(echo "$PR_JSON" | jq -r '.body')
FILES_CHANGED=$(echo "$PR_JSON" | jq -r '.files[].path' | tr '\n' ' ')
ADDITIONS=$(echo "$PR_JSON" | jq -r '.additions')
DELETIONS=$(echo "$PR_JSON" | jq -r '.deletions')

log "PR: $PR_TITLE"
log "Files changed: $(echo "$FILES_CHANGED" | wc -w) ($ADDITIONS additions, $DELETIONS deletions)"

# Get diff
DIFF=$(gh pr diff "$PR_NUMBER")

# Reviewer 1: Codex (Edge Cases & Logic)
review_with_codex() {
  info "[1/3] Codex review starting..."
  
  local prompt="You are reviewing a pull request. Focus on:
- Edge cases and error handling
- Logic errors and race conditions
- Performance implications
- Missing validation

PR Title: $PR_TITLE
Files: $FILES_CHANGED

Diff:
\`\`\`
$DIFF
\`\`\`

Provide specific, actionable feedback. Mark critical issues with [CRITICAL].
If no issues, respond with: LGTM - No issues found."

  local review=""
  if command -v codex &>/dev/null; then
    review=$(codex --model gpt-5.3-codex -c 'model_reasoning_effort=medium' --dangerously-bypass-approvals-and-sandbox "$prompt" 2>/dev/null || echo "Review failed")
  else
    review=$(curl -s -X POST http://localhost:5010/api/dispatch \
      -H "Content-Type: application/json" \
      -d "{\"agent\":\"crew-coder\",\"task\":$(echo "$prompt" | jq -Rs .)}" \
      | jq -r '.result // "Review pending"')
  fi
  
  # Post as comment
  if [[ "$review" != *"LGTM"* ]]; then
    gh pr comment "$PR_NUMBER" --body "## 🤖 Codex Review

$review

---
*Automated review by Codex (Edge Cases & Logic)*"
    warn "Codex found issues"
    return 1
  else
    log "✓ Codex: LGTM"
    return 0
  fi
}

# Reviewer 2: Gemini (Security & Scale)
review_with_gemini() {
  info "[2/3] Gemini review starting..."
  
  local prompt="You are a security and scalability reviewer. Focus on:
- Security vulnerabilities (injection, XSS, auth bypass)
- Scalability issues (N+1 queries, memory leaks)
- Missing input validation
- API design flaws

PR Title: $PR_TITLE
Files: $FILES_CHANGED

Diff:
\`\`\`
$DIFF
\`\`\`

Provide specific fixes. Mark security issues with [SECURITY].
If no issues, respond with: LGTM - No issues found."

  local review=""
  if command -v gemini &>/dev/null; then
    review=$(gemini code review --input <(echo "$prompt") 2>/dev/null || echo "Review failed")
  else
    # Use Gemini API directly
    local api_key=$(jq -r '.providers.google.apiKey // empty' ~/.crewswarm/crewswarm.json)
    if [ -n "$api_key" ]; then
      review=$(curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$api_key" \
        -H 'Content-Type: application/json' \
        -d "{\"contents\":[{\"parts\":[{\"text\":$(echo "$prompt" | jq -Rs .)}]}]}" \
        | jq -r '.candidates[0].content.parts[0].text // "Review failed"')
    else
      review="Gemini API key not configured"
    fi
  fi
  
  if [[ "$review" != *"LGTM"* ]]; then
    gh pr comment "$PR_NUMBER" --body "## 🔒 Gemini Review (Security & Scale)

$review

---
*Automated review by Gemini Code Assist*"
    warn "Gemini found issues"
    return 1
  else
    log "✓ Gemini: LGTM"
    return 0
  fi
}

# Reviewer 3: Claude (Validation)
review_with_claude() {
  info "[3/3] Claude review starting..."
  
  local prompt="You are a code quality reviewer. Focus on:
- Code clarity and maintainability
- Missing tests or documentation
- Validation of other reviewers' findings

PR Title: $PR_TITLE
Files: $FILES_CHANGED

Diff:
\`\`\`
$DIFF
\`\`\`

Mark critical issues with [CRITICAL].
If no issues, respond with: LGTM - No issues found."

  local review=""
  if command -v claude &>/dev/null; then
    review=$(claude --model claude-opus-4.5 --dangerously-skip-permissions -p "$prompt" 2>/dev/null || echo "Review failed")
  else
    local api_key=$(jq -r '.providers.anthropic.apiKey // empty' ~/.crewswarm/crewswarm.json)
    if [ -n "$api_key" ]; then
      review=$(curl -s -X POST https://api.anthropic.com/v1/messages \
        -H "x-api-key: $api_key" \
        -H "anthropic-version: 2023-06-01" \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"claude-opus-4.5\",\"max_tokens\":2000,\"messages\":[{\"role\":\"user\",\"content\":$(echo "$prompt" | jq -Rs .)}]}" \
        | jq -r '.content[0].text // "Review failed"')
    else
      review="Claude API key not configured"
    fi
  fi
  
  if [[ "$review" != *"LGTM"* ]]; then
    gh pr comment "$PR_NUMBER" --body "## 🧐 Claude Review (Quality)

$review

---
*Automated review by Claude*"
    warn "Claude found issues"
    return 1
  else
    log "✓ Claude: LGTM"
    return 0
  fi
}

# Run all reviews
CODEX_PASS=0
GEMINI_PASS=0
CLAUDE_PASS=0

review_with_codex && CODEX_PASS=1 || true
review_with_gemini && GEMINI_PASS=1 || true  
review_with_claude && CLAUDE_PASS=1 || true

# Summary
TOTAL_PASS=$((CODEX_PASS + GEMINI_PASS + CLAUDE_PASS))

log ""
log "===================="
log "Review Summary"
log "===================="
log "Codex:  $([ $CODEX_PASS -eq 1 ] && echo '✓ PASS' || echo '✗ FAIL')"
log "Gemini: $([ $GEMINI_PASS -eq 1 ] && echo '✓ PASS' || echo '✗ FAIL')"
log "Claude: $([ $CLAUDE_PASS -eq 1 ] && echo '✓ PASS' || echo '✗ FAIL')"
log ""
log "Total: $TOTAL_PASS/3 reviewers approved"

# Post summary comment
gh pr comment "$PR_NUMBER" --body "## 🎯 AI Review Summary

| Reviewer | Focus | Status |
|----------|-------|--------|
| 🤖 Codex | Edge Cases & Logic | $([ $CODEX_PASS -eq 1 ] && echo '✅ PASS' || echo '❌ FAIL') |
| 🔒 Gemini | Security & Scale | $([ $GEMINI_PASS -eq 1 ] && echo '✅ PASS' || echo '❌ FAIL') |
| 🧐 Claude | Quality | $([ $CLAUDE_PASS -eq 1 ] && echo '✅ PASS' || echo '❌ FAIL') |

**Result:** $TOTAL_PASS/3 reviewers approved

$([ $TOTAL_PASS -eq 3 ] && echo '✅ **All checks passed!** Ready for merge.' || echo '⚠️ **Issues found.** Review comments above.')

---
*Run \`scripts/multi-ai-review.sh $PR_NUMBER\` to re-review after changes*"

if [ $TOTAL_PASS -eq 3 ]; then
  log "✓ All reviews passed"
  exit 0
else
  warn "Some reviews failed"
  exit 1
fi
