#!/bin/bash
# CI Monitor + Auto-Retry
# Polls CI status for all open PRs, auto-respawns failed agents

set -e

MAX_RETRIES=3
CHECK_INTERVAL=60  # seconds
TASKS_FILE="$HOME/.crewswarm/active-tasks.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[ci-monitor]${NC} $1"; }
warn() { echo -e "${YELLOW}[ci-monitor]${NC} $1"; }
error() { echo -e "${RED}[ci-monitor]${NC} $1"; }

# Get all PRs with CI status
get_pr_status() {
  local pr_number="$1"
  
  # Get CI status via gh CLI
  gh pr checks "$pr_number" --json name,status,conclusion 2>/dev/null | \
    jq -r '.[] | "\(.name):\(.status):\(.conclusion)"'
}

# Check if all CI checks passed
all_checks_passed() {
  local pr_number="$1"
  local checks=$(get_pr_status "$pr_number")
  
  if [ -z "$checks" ]; then
    echo "no_checks"
    return 1
  fi
  
  # Check if any failed
  if echo "$checks" | grep -q "failure"; then
    echo "failed"
    return 1
  fi
  
  # Check if all completed successfully
  if echo "$checks" | grep -q "completed:success"; then
    if ! echo "$checks" | grep -qE "pending|in_progress"; then
      echo "passed"
      return 0
    fi
  fi
  
  echo "pending"
  return 1
}

# Get failed check details
get_failed_checks() {
  local pr_number="$1"
  gh pr checks "$pr_number" --json name,status,conclusion,detailsUrl | \
    jq -r '.[] | select(.conclusion == "failure") | "\(.name): \(.detailsUrl)"'
}

# Respawn agent for failed task
respawn_agent() {
  local task_id="$1"
  local reason="$2"
  
  # Get task details
  local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
  local retries=$(echo "$task" | jq -r '.retries // 0')
  local agent=$(echo "$task" | jq -r '.agent')
  local description=$(echo "$task" | jq -r '.description')
  local worktree=$(echo "$task" | jq -r '.worktree')
  
  if [ $retries -ge $MAX_RETRIES ]; then
    error "Max retries reached for $task_id"
    return 1
  fi
  
  log "Respawning agent for $task_id (retry $((retries + 1))/$MAX_RETRIES)"
  warn "Reason: $reason"
  
  # Increment retry count
  local updated=$(jq --arg id "$task_id" --arg retries "$((retries + 1))" \
    '(.tasks[] | select(.id == $id)) |= (. + {retries: ($retries | tonumber), status: "retrying"})' \
    "$TASKS_FILE")
  echo "$updated" > "$TASKS_FILE"
  
  # Read failure context
  local failure_context="Previous attempt failed: $reason

Review the CI logs and fix the issues. Common causes:
- TypeScript errors
- Test failures
- Linter violations
- Missing dependencies"
  
  # Build enhanced prompt with failure context
  local enhanced_prompt="$description

$failure_context

Previous implementation is in: $worktree
Review what went wrong and fix it."
  
  # Kill old tmux session
  local old_session=$(echo "$task" | jq -r '.tmuxSession')
  if [ -n "$old_session" ] && [ "$old_session" != "null" ]; then
    tmux kill-session -t "$old_session" 2>/dev/null || true
  fi
  
  # Spawn new agent
  ./scripts/worktree-manager.sh spawn "$task_id" "$agent" "$enhanced_prompt"
  
  log "✓ Agent respawned for $task_id"
}

# Monitor active tasks
monitor_tasks() {
  log "Monitoring active tasks..."
  
  local tasks=$(jq -r '.tasks[] | select(.pr != null) | .id' "$TASKS_FILE" 2>/dev/null || echo "")
  
  if [ -z "$tasks" ]; then
    log "No active PRs to monitor"
    return
  fi
  
  while IFS= read -r task_id; do
    local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
    local pr_number=$(echo "$task" | jq -r '.pr')
    local status=$(echo "$task" | jq -r '.status')
    
    if [ -z "$pr_number" ] || [ "$pr_number" = "null" ]; then
      continue
    fi
    
    log "Checking PR #$pr_number for task $task_id..."
    
    local ci_status=$(all_checks_passed "$pr_number")
    
    case "$ci_status" in
      passed)
        log "✓ PR #$pr_number passed all checks"
        
        # Update status
        local updated=$(jq --arg id "$task_id" \
          '(.tasks[] | select(.id == $id)) |= (. + {status: "ci_passed"})' \
          "$TASKS_FILE")
        echo "$updated" > "$TASKS_FILE"
        
        # Notify
        notify_telegram "✅ PR #$pr_number passed CI" "$task_id"
        ;;
      failed)
        error "✗ PR #$pr_number failed CI"
        
        # Get failure details
        local failed_checks=$(get_failed_checks "$pr_number")
        
        # Respawn if not max retries
        respawn_agent "$task_id" "CI failed:\n$failed_checks"
        ;;
      pending)
        log "⏳ PR #$pr_number CI pending..."
        ;;
      no_checks)
        warn "No CI checks configured for PR #$pr_number"
        ;;
    esac
  done <<< "$tasks"
}

# Notify via Telegram
notify_telegram() {
  local message="$1"
  local task_id="$2"
  
  local telegram_config=$(jq -r '.telegram // empty' ~/.crewswarm/crewswarm.json)
  if [ -z "$telegram_config" ]; then
    return
  fi
  
  local bot_token=$(echo "$telegram_config" | jq -r '.botToken // empty')
  local chat_id=$(echo "$telegram_config" | jq -r '.chatId // empty')
  
  if [ -n "$bot_token" ] && [ -n "$chat_id" ]; then
    curl -s -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
      -d "chat_id=${chat_id}" \
      -d "text=${message}

Task: ${task_id}" > /dev/null || true
  fi
}

# Main loop (runs continuously)
main() {
  log "CI Monitor starting..."
  log "Check interval: ${CHECK_INTERVAL}s"
  log "Max retries: $MAX_RETRIES"
  
  while true; do
    monitor_tasks
    log "Sleeping ${CHECK_INTERVAL}s..."
    sleep "$CHECK_INTERVAL"
  done
}

# Command dispatcher
case "${1:-monitor}" in
  monitor)
    main
    ;;
  check)
    monitor_tasks
    ;;
  respawn)
    respawn_agent "$2" "$3"
    ;;
  *)
    cat <<EOF
Usage: ci-monitor.sh [command]

Commands:
  monitor     Run continuous monitoring (default)
  check       Check status once and exit
  respawn <task_id> <reason>
              Manually respawn agent for a task

Examples:
  # Run as daemon (recommended via cron)
  ./ci-monitor.sh monitor

  # Check once
  ./ci-monitor.sh check

  # Manual respawn
  ./ci-monitor.sh respawn feat-login "CI failed: tests"

Cron setup (check every 10 minutes):
  */10 * * * * cd /path/to/CrewSwarm && ./scripts/ci-monitor.sh check
EOF
    ;;
esac
