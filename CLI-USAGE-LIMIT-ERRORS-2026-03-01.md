# CLI Usage Limit Error Display — Fixed

**Date:** 2026-03-01  
**Issue:** Dashboard chat didn't show usage limit errors from CLI agents (Codex, Claude Code, Cursor, Gemini)  
**Root Cause:** Silent fallback behavior in `lib/engines/rt-envelope.mjs`

## Problem

When CLI agents hit usage limits, the error handling code would:
1. Catch the error
2. Log to telemetry
3. Silently fall back to direct LLM
4. **Never inform the user**

Example from line 404-407 (before fix):
```javascript
} catch (e) {
  const msg = e?.message ?? String(e);
  progress(`Codex CLI failed: ${msg.slice(0, 120)} — falling back to direct LLM`);
  telemetry("codex_fallback", { taskId, error: msg });
  reply = await callLLMDirect(finalPrompt, CREWSWARM_RT_AGENT, null);
}
```

User would never see "You've hit your usage limit until March 5th" — they'd just get a random LLM response.

## Solution

Modified all four CLI engine error handlers to:
1. Detect usage limit errors via regex pattern matching
2. Return the actual error message to the user
3. Disable fallback for usage limits (so user sees the problem)
4. Keep fallback for other errors (network, timeout, etc.)

## Files Changed

- `lib/engines/rt-envelope.mjs` — Added usage limit detection and error return for:
  - **Cursor CLI** (lines 358-374)
  - **Claude Code** (lines 392-408)
  - **Codex CLI** (lines 417-433)
  - **Gemini CLI** (lines 457-473)

## Pattern Recognition

Error messages matching this regex are treated as usage limits:
```javascript
/usage.*limit|hit.*limit|quota.*exceeded|limit.*reset/i
```

Matches:
- "You've hit your usage limit"
- "Usage limit reached"
- "Quota exceeded"
- "Rate limit reset at 7 PM"

## User Experience

**Before:**
```
User: dispatch crew-coder to write auth.js
Assistant: [silently uses Groq fallback, confusing user]
```

**After:**
```
User: dispatch crew-coder to write auth.js
Assistant: ❌ Codex CLI usage limit reached:

You've hit your usage limit for Codex until March 5th.

(Fallback to direct LLM disabled to show you the error)
```

## Telemetry

New telemetry events added:
- `cursor_cli_usage_limit`
- `claude_code_usage_limit`
- `codex_usage_limit`
- `gemini_cli_usage_limit`

Existing fallback events retained for non-limit errors.

## Testing

To verify:
1. Configure an agent to use Codex/Claude Code/Cursor/Gemini CLI
2. Hit the usage limit
3. Dispatch a task to that agent
4. Check chat response — should see error message with ❌ prefix

## Related Documentation

- `AGENTS.md` — Agent engine configuration
- `lib/engines/rt-envelope.mjs` — Engine routing logic
- `~/.crewswarm/crewswarm.json` — Per-agent engine settings

---

**Status:** ✅ Complete — All CLI engines now return usage limit errors to chat
