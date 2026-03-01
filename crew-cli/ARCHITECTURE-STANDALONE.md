# CrewSwarm CLI - Standalone Architecture

## Problem

The old architecture was confusing with multiple overlapping layers:

```
User → Router LLM → crew-main → Gateway → crew-main prompt → Another LLM
```

This created:
- Redundant routing through crew-main
- Mandatory gateway dependency for simple tasks
- Confusing modes (manual/assist/autopilot)
- Prompt fragmentation across layers

## New Architecture

### Standalone First, Gateway Optional

```
User → Router (Tier 1) → Local Executor (Tier 2) → Specialist (Tier 3, optional)
          ↓                    ↓                         ↓
     Grok/Gemini/DeepSeek  Grok/Gemini/DeepSeek    Gateway (optional)
```

### Three Clear Tiers

**Tier 1: Router** (`src/orchestrator/index.ts`)
- Decides: CHAT, CODE, DISPATCH, or SKILL
- Uses: Grok/Gemini/DeepSeek in configurable order
- Fast, cheap routing decisions

**Tier 2: Local Executor** (`src/executor/local.ts`) ✨ NEW
- Executes tasks directly without gateway
- Uses: Grok/Gemini/DeepSeek for execution
- Handles 90% of daily tasks standalone

**Tier 3: Specialists** (optional)
- For complex multi-agent coordination
- Uses gateway only when needed
- Examples: crew-qa, crew-pm, crew-security

### Runtime Profiles (replaces modes)

Instead of confusing `manual/assist/autopilot`, you now get:

**`chat`** - Conversational
- Local LLM only
- No code execution
- No gateway needed
- Use for: Questions, planning, discussion

**`builder`** - Development (DEFAULT)
- Local execution
- Manual approval for changes
- No gateway needed
- Use for: Building features, writing code

**`orchestrator`** - Team Mode
- Uses gateway for specialists
- Multi-agent coordination
- Optional for complex workflows
- Use for: Large projects, QA reviews, security audits

## Configuration

### API Keys (Priority Order)

```bash
# Set your preferred LLMs
export XAI_API_KEY="your-grok-key"           # Grok (x.ai) - fast, smart
export GEMINI_API_KEY="your-gemini-key"      # Gemini - cheap, 2M context
export DEEPSEEK_API_KEY="your-deepseek-key"  # DeepSeek - code specialist

# Configure routing priority
export CREW_ROUTING_ORDER="grok,gemini,deepseek"  # Default
```

### Profiles

```bash
# Start REPL in specific profile
crew repl --profile chat         # Conversational only
crew repl --profile builder      # Build mode (default)
crew repl --profile orchestrator # Team coordination

# Or set in config
# .crew/config.json
{
  "repl": {
    "profile": "builder"
  }
}
```

## Usage Examples

### Standalone (No Gateway)

```bash
# Chat mode - quick questions
crew repl --profile chat
> what's the best way to handle auth in Express?
[local-router → local-executor (grok)]
Response: Here's a secure approach using JWT...

# Builder mode - write code
crew repl --profile builder
> build me a REST API for user management
[local-router → local-executor (grok)]
Response: I'll create the API structure...
  ✓ 3 files changed in sandbox
  Type /preview to review or /apply to write to disk
```

### With Gateway (Optional)

```bash
# Orchestrator mode - complex projects
crew repl --profile orchestrator
> build a full auth system with tests and security review
[local-router → gateway → crew-pm]
Response: Creating project plan...
[Dispatching to crew-coder, crew-qa, crew-security]
```

## Benefits

1. **Works Offline** - No gateway required for 90% of tasks
2. **Clear Execution Path** - Always see: router → executor → result
3. **Simple Profiles** - chat/builder/orchestrator instead of confusing modes
4. **No crew-main Dependency** - Direct execution, no intermediate routing
5. **Gateway Optional** - Only for team/specialist features
6. **Unified Prompts** - Router and executor use same context

## Migration

Old modes map to new profiles:

| Old Mode | New Profile | Behavior |
|----------|-------------|----------|
| manual | builder | Local execution, manual approval |
| assist | builder | Same (memory is now always available) |
| autopilot | builder + auto-apply | Use `/auto-apply` command |
| N/A | chat | New: conversation-only mode |
| N/A | orchestrator | New: gateway-based coordination |

## Files Changed

### New
- `src/executor/local.ts` - Standalone Tier 2 executor
- `src/executor/profiles.ts` - Runtime profile definitions
- `ARCHITECTURE-STANDALONE.md` - This document

### Modified
- `src/orchestrator/index.ts` - Added local execution, profiles
- `src/repl/index.ts` - Uses profiles instead of modes
- `src/cli/index.ts` - Added --profile flag

## Next Steps

1. ✅ Phase 1: Local executor (DONE)
2. 🔄 Phase 2: Update REPL to use profiles (IN PROGRESS)
3. ⏳ Phase 3: Add execution path visibility
4. ⏳ Phase 4: Add `/delegate` command for explicit gateway routing
5. ⏳ Phase 5: Remove gateway requirement from default flows

## Testing

```bash
# Test standalone execution (no gateway needed)
unset CREW_LEAD_URL
crew repl --profile builder
> write a hello world server

# Should work without gateway!
```

## Cost Comparison

**Grok**: $5/1M input, $15/1M output
**Gemini**: $0.075/1M input, $0.30/1M output (cheapest!)
**DeepSeek**: $0.27/1M input, $1.10/1M output (best for code)

Set `CREW_ROUTING_ORDER="gemini,deepseek,grok"` for lowest cost.
