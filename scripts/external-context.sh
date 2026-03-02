#!/bin/bash
# External Context Integration
# Syncs Obsidian vault and meeting notes into CrewSwarm memory

set -e

OBSIDIAN_VAULT="${OBSIDIAN_VAULT_PATH:-$HOME/Documents/Obsidian}"
MEETING_NOTES_DIR="$HOME/.crewswarm/external-context/meeting-notes"
CUSTOMER_NOTES_DIR="$HOME/.crewswarm/external-context/customers"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[context]${NC} $1"; }
warn() { echo -e "${YELLOW}[context]${NC} $1"; }

# Initialize external context directories
init_context() {
  mkdir -p "$MEETING_NOTES_DIR"
  mkdir -p "$CUSTOMER_NOTES_DIR"
  log "External context initialized"
}

# Sync Obsidian vault (read-only)
sync_obsidian() {
  if [ ! -d "$OBSIDIAN_VAULT" ]; then
    warn "Obsidian vault not found at $OBSIDIAN_VAULT"
    warn "Set OBSIDIAN_VAULT_PATH environment variable"
    return 1
  fi
  
  log "Syncing Obsidian vault..."
  
  # Index all markdown files
  find "$OBSIDIAN_VAULT" -name "*.md" -type f | while read -r file; do
    local basename=$(basename "$file" .md)
    local category=$(dirname "$file" | sed "s|$OBSIDIAN_VAULT/||")
    
    # Create symlinks in external context (read-only)
    local target_dir="$HOME/.crewswarm/external-context/obsidian/$category"
    mkdir -p "$target_dir"
    ln -sf "$file" "$target_dir/$basename.md" 2>/dev/null || true
  done
  
  local count=$(find "$OBSIDIAN_VAULT" -name "*.md" -type f | wc -l)
  log "✓ Indexed $count Obsidian notes"
}

# Search Obsidian for relevant context
search_obsidian() {
  local query="$1"
  
  if [ ! -d "$OBSIDIAN_VAULT" ]; then
    return 1
  fi
  
  log "Searching Obsidian for: $query"
  
  # Use ripgrep for fast search
  rg -i --max-count 3 --context 2 "$query" "$OBSIDIAN_VAULT" || true
}

# Add meeting note
add_meeting_note() {
  local customer="$1"
  local date="${2:-$(date +%Y-%m-%d)}"
  local notes="$3"
  
  local customer_slug=$(echo "$customer" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  local note_file="$MEETING_NOTES_DIR/${customer_slug}-${date}.md"
  
  cat > "$note_file" <<EOF
# Meeting Notes: $customer

**Date:** $date
**Customer:** $customer

## Notes

$notes

---
*Added: $(date)*
EOF
  
  log "✓ Meeting notes saved: $note_file"
}

# Webhook endpoint for meeting notes (called by Zapier/Make)
webhook_meeting_notes() {
  # This would be called by an HTTP webhook
  # For now, just a placeholder showing the structure
  
  cat <<EOF
{
  "endpoint": "POST http://localhost:5010/api/external-context/meeting",
  "body": {
    "customer": "Acme Corp",
    "date": "2026-03-01",
    "attendees": ["alice@acme.com"],
    "notes": "Customer wants template feature...",
    "source": "zoom"
  }
}

Add to Zapier:
1. Trigger: Zoom meeting ends
2. Action: HTTP POST to CrewSwarm
3. Map fields: customer, notes, attendees
EOF
}

# Get customer context
get_customer_context() {
  local customer="$1"
  local customer_slug=$(echo "$customer" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  
  log "Loading context for customer: $customer"
  
  # Search meeting notes
  local meeting_notes=$(find "$MEETING_NOTES_DIR" -name "${customer_slug}-*.md" -exec cat {} \; 2>/dev/null || echo "")
  
  # Search customer notes
  local customer_file="$CUSTOMER_NOTES_DIR/${customer_slug}.md"
  local customer_notes=""
  if [ -f "$customer_file" ]; then
    customer_notes=$(cat "$customer_file")
  fi
  
  # Combine
  cat <<EOF
## Customer Context: $customer

### Meeting History
$meeting_notes

### Customer Profile
$customer_notes

---
EOF
}

# Command dispatcher
case "${1:-help}" in
  sync)
    init_context
    sync_obsidian
    ;;
  search)
    search_obsidian "$2"
    ;;
  add-meeting)
    add_meeting_note "$2" "$3" "$4"
    ;;
  get-customer)
    get_customer_context "$2"
    ;;
  webhook-info)
    webhook_meeting_notes
    ;;
  *)
    cat <<EOF
Usage: external-context.sh <command> [args]

Commands:
  sync
    Sync Obsidian vault into CrewSwarm context
  
  search <query>
    Search Obsidian for relevant notes
  
  add-meeting <customer> <date> <notes>
    Add meeting notes for a customer
  
  get-customer <customer>
    Get all context for a customer
  
  webhook-info
    Show webhook setup for Zapier/Make

Environment:
  OBSIDIAN_VAULT_PATH   Path to Obsidian vault (default: ~/Documents/Obsidian)

Examples:
  # Sync Obsidian
  ./external-context.sh sync
  
  # Search for context
  ./external-context.sh search "authentication issues"
  
  # Add meeting notes
  ./external-context.sh add-meeting "Acme Corp" "2026-03-01" "Customer wants templates..."
  
  # Get customer context
  ./external-context.sh get-customer "Acme Corp"

Integration with agents:
  When dispatching tasks, include customer context:
  
  customer_context=\$(./external-context.sh get-customer "Acme Corp")
  crew dispatch crew-coder "\$task\n\n\$customer_context"
EOF
    ;;
esac
