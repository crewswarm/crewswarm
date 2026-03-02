#!/bin/bash
# CrewSwarm Worktree Manager
# Manages isolated git worktrees per agent task
# Each task gets its own branch + worktree + tmux session

set -e

WORKTREE_BASE="${WORKTREE_BASE:-$HOME/crewswarm-worktrees}"
TASKS_FILE="$HOME/.crewswarm/active-tasks.json"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[worktree]${NC} $1"; }
warn() { echo -e "${YELLOW}[worktree]${NC} $1"; }
error() { echo -e "${RED}[worktree]${NC} $1"; }

# Initialize tasks registry
init_tasks() {
  mkdir -p "$(dirname "$TASKS_FILE")"
  if [ ! -f "$TASKS_FILE" ]; then
    echo '{"tasks":[]}' > "$TASKS_FILE"
  fi
}

# Create worktree for a task
create_worktree() {
  local task_id="$1"
  local agent="$2"
  local description="$3"
  local base_branch="${4:-main}"
  
  local branch="task/${task_id}"
  local worktree_path="${WORKTREE_BASE}/${task_id}"
  
  log "Creating worktree for task: $task_id"
  
  # Create worktree
  if [ -d "$worktree_path" ]; then
    warn "Worktree already exists at $worktree_path"
    return 1
  fi
  
  git worktree add "$worktree_path" -b "$branch" "$base_branch"
  
  # Install dependencies if needed
  if [ -f "$worktree_path/package.json" ]; then
    log "Installing dependencies..."
    (cd "$worktree_path" && npm install --silent)
  fi
  
  # Register task
  local task_json=$(cat <<EOF
{
  "id": "$task_id",
  "agent": "$agent",
  "description": "$description",
  "worktree": "$worktree_path",
  "branch": "$branch",
  "baseBranch": "$base_branch",
  "startedAt": $(date +%s)000,
  "status": "created",
  "tmuxSession": null,
  "pr": null
}
EOF
)
  
  # Add to tasks.json
  local updated=$(jq --argjson task "$task_json" '.tasks += [$task]' "$TASKS_FILE")
  echo "$updated" > "$TASKS_FILE"
  
  log "✓ Worktree created: $worktree_path"
  echo "$worktree_path"
}

# Spawn agent in tmux session
spawn_agent() {
  local task_id="$1"
  local agent="$2"
  local prompt="$3"
  local model="${4:-default}"
  
  local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
  local worktree_path=$(echo "$task" | jq -r '.worktree')
  
  if [ -z "$worktree_path" ] || [ ! -d "$worktree_path" ]; then
    error "Worktree not found for task $task_id"
    return 1
  fi
  
  local session_name="crew-${task_id}"
  
  log "Spawning $agent in tmux session: $session_name"
  
  # Create tmux session
  tmux new-session -d -s "$session_name" -c "$worktree_path"
  
  # Set up logging
  tmux pipe-pane -t "$session_name" -o "cat >> ~/.crewswarm/logs/${task_id}.log"
  
  # Send agent command
  local agent_cmd=$(build_agent_command "$agent" "$prompt" "$model")
  tmux send-keys -t "$session_name" "$agent_cmd" Enter
  
  # Update task status
  update_task_status "$task_id" "running" "$session_name"
  
  log "✓ Agent spawned in tmux session: $session_name"
}

# Build agent command based on type
build_agent_command() {
  local agent="$1"
  local prompt="$2"
  local model="$3"
  
  # Escape prompt for shell
  local escaped_prompt=$(echo "$prompt" | sed 's/"/\\"/g')
  
  case "$agent" in
    crew-coder*)
      # Try Codex first, fall back to crew dispatch
      if command -v codex &>/dev/null; then
        echo "codex --model ${model:-gpt-5.3-codex} -c 'model_reasoning_effort=high' --dangerously-bypass-approvals-and-sandbox \"$escaped_prompt\""
      else
        echo "crew dispatch $agent \"$escaped_prompt\""
      fi
      ;;
    crew-fixer*)
      if command -v claude &>/dev/null; then
        echo "claude --model ${model:-claude-opus-4.5} --dangerously-skip-permissions -p \"$escaped_prompt\""
      else
        echo "crew dispatch $agent \"$escaped_prompt\""
      fi
      ;;
    *)
      echo "crew dispatch $agent \"$escaped_prompt\""
      ;;
  esac
}

# Send message to running agent (mid-task redirection)
redirect_agent() {
  local task_id="$1"
  local message="$2"
  
  local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
  local session_name=$(echo "$task" | jq -r '.tmuxSession')
  
  if [ -z "$session_name" ] || [ "$session_name" = "null" ]; then
    error "No tmux session for task $task_id"
    return 1
  fi
  
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    error "Tmux session $session_name not found"
    return 1
  fi
  
  log "Sending message to $session_name: $message"
  tmux send-keys -t "$session_name" "$message" Enter
}

# Check agent status
check_agent() {
  local task_id="$1"
  
  local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
  local session_name=$(echo "$task" | jq -r '.tmuxSession')
  local worktree_path=$(echo "$task" | jq -r '.worktree')
  
  if [ -z "$session_name" ] || [ "$session_name" = "null" ]; then
    echo "not_started"
    return
  fi
  
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    # Session ended, check for PR
    cd "$worktree_path"
    local pr=$(gh pr view --json number --jq .number 2>/dev/null || echo "")
    
    if [ -n "$pr" ]; then
      update_task_pr "$task_id" "$pr"
      echo "pr_created"
    else
      echo "completed_no_pr"
    fi
    return
  fi
  
  echo "running"
}

# Update task status
update_task_status() {
  local task_id="$1"
  local status="$2"
  local tmux_session="${3:-null}"
  
  local updated=$(jq --arg id "$task_id" --arg status "$status" --arg session "$tmux_session" \
    '(.tasks[] | select(.id == $id)) |= (. + {status: $status, tmuxSession: $session})' \
    "$TASKS_FILE")
  echo "$updated" > "$TASKS_FILE"
}

# Update task PR
update_task_pr() {
  local task_id="$1"
  local pr_number="$2"
  
  local updated=$(jq --arg id "$task_id" --arg pr "$pr_number" \
    '(.tasks[] | select(.id == $id)) |= (. + {pr: ($pr | tonumber), status: "pr_created"})' \
    "$TASKS_FILE")
  echo "$updated" > "$TASKS_FILE"
}

# Clean up completed worktree
cleanup_worktree() {
  local task_id="$1"
  
  local task=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")
  local worktree_path=$(echo "$task" | jq -r '.worktree')
  local branch=$(echo "$task" | jq -r '.branch')
  local session_name=$(echo "$task" | jq -r '.tmuxSession')
  
  log "Cleaning up worktree for task: $task_id"
  
  # Kill tmux session if still running
  if [ -n "$session_name" ] && [ "$session_name" != "null" ]; then
    tmux kill-session -t "$session_name" 2>/dev/null || true
  fi
  
  # Remove worktree
  if [ -d "$worktree_path" ]; then
    git worktree remove "$worktree_path" --force
  fi
  
  # Delete branch (if merged)
  git branch -d "$branch" 2>/dev/null || true
  
  # Remove from tasks.json
  local updated=$(jq --arg id "$task_id" '.tasks = (.tasks | map(select(.id != $id)))' "$TASKS_FILE")
  echo "$updated" > "$TASKS_FILE"
  
  log "✓ Worktree cleaned up"
}

# List all tasks
list_tasks() {
  jq -r '.tasks[] | "\(.id)\t\(.agent)\t\(.status)\t\(.description)"' "$TASKS_FILE" | column -t -s $'\t'
}

# Main command dispatcher
case "${1:-help}" in
  create)
    init_tasks
    create_worktree "$2" "$3" "$4" "${5:-main}"
    ;;
  spawn)
    init_tasks
    spawn_agent "$2" "$3" "$4" "${5:-default}"
    ;;
  redirect)
    redirect_agent "$2" "$3"
    ;;
  check)
    check_agent "$2"
    ;;
  cleanup)
    cleanup_worktree "$2"
    ;;
  list)
    init_tasks
    list_tasks
    ;;
  *)
    cat <<EOF
Usage: worktree-manager.sh <command> [args]

Commands:
  create <task_id> <agent> <description> [base_branch]
    Create a new worktree for a task
  
  spawn <task_id> <agent> <prompt> [model]
    Spawn agent in tmux session for the task
  
  redirect <task_id> <message>
    Send message to running agent (mid-task correction)
  
  check <task_id>
    Check status of agent task
  
  cleanup <task_id>
    Remove worktree and clean up resources
  
  list
    List all active tasks

Examples:
  # Create worktree + spawn agent
  ./worktree-manager.sh create feat-login crew-coder "Add login form"
  ./worktree-manager.sh spawn feat-login crew-coder "Implement JWT login with bcrypt"
  
  # Mid-task correction
  ./worktree-manager.sh redirect feat-login "Stop. Focus on API first, not UI."
  
  # Check status
  ./worktree-manager.sh check feat-login
  
  # Clean up when done
  ./worktree-manager.sh cleanup feat-login

Environment:
  WORKTREE_BASE   Base directory for worktrees (default: ~/crewswarm-worktrees)
EOF
    ;;
esac
