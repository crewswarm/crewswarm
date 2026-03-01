# crew-cli Sandbox Safety Guide

**By Gunns, your lethal CLI weapon** 💥

## THE PROBLEM

**Target missed, Captain!** crew repl routing to gateway agents (crew-main, crew-coder) bypasses the sandbox!

Gateway agents use `@@WRITE_FILE` which writes DIRECTLY to disk.  
The sandbox only catches SEARCH/REPLACE blocks (which gateway agents don't use).

### What Just Happened

```bash
crew> code me a quick html page
→ crew-main (CODE)
→ Uses @@WRITE_FILE /Users/jeffhobbs/Desktop/CrewSwarm/index.html
→ Writes DIRECTLY to your repo (no sandbox!) ❌
```

**Mission failure. Fired at the wrong target, Captain.**

---

## SAFE USAGE

### Option 1: Work in a Test Directory (RECOMMENDED)

```bash
# Create a sandbox directory
mkdir ~/crew-test
cd ~/crew-test

# Now run crew repl
crew repl

# Agents will write to ~/crew-test, not your repo
crew> code me an html page
→ Writes to ~/crew-test/index.html ✅
```

### Option 2: Use Local Agent (No Gateway)

When crew-cli gets local agent execution (coming soon), it will use SEARCH/REPLACE by default.

### Option 3: Explicit Project Directory

Tell agents WHERE to write:

```bash
crew repl
crew> code me an html page at /tmp/test.html
→ Writes to /tmp/test.html ✅
```

---

## HOW THE SANDBOX WORKS

The sandbox (`~/.crew/sandbox.json`) stores pending changes:

```bash
# View pending changes
/preview

# Apply to disk
/apply

# Discard changes
/rollback

# Auto-apply mode (dangerous with gateway!)
/auto-apply
```

**But:** Sandbox ONLY works for SEARCH/REPLACE blocks, not `@@WRITE_FILE` commands.

---

## WHEN IS IT SAFE?

✅ **Safe:**
- Working in a dedicated project directory (`cd ~/my-project && crew repl`)
- Explicitly telling agents where to write (`code X at /tmp/file.js`)
- Using agents that output SEARCH/REPLACE blocks (future local agents)

❌ **Unsafe:**
- Running `crew repl` in your main CrewSwarm repo
- Asking agents to "code me X" without specifying path
- Auto-apply ON with gateway routing

---

## THE FIX (Coming)

Need to modify agents to use SEARCH/REPLACE format instead of `@@WRITE_FILE` when called from crew-cli.

**Two approaches:**

1. **Modify `CLI_SYSTEM_PROMPT`** (already exists in `agent/prompt.ts`)  
   → Tell agents to ONLY use SEARCH/REPLACE  
   → Gateway ignores this because it has its own prompts

2. **Add Local Agent Execution**  
   → crew-cli calls LLM directly (no gateway)  
   → Uses CLI_SYSTEM_PROMPT (which mandates SEARCH/REPLACE)  
   → Sandbox works correctly

---

## CURRENT WORKAROUND

**Always cd to a test directory before using `crew repl`:**

```bash
# Add to ~/.zshrc
alias crew-safe='mkdir -p ~/crew-sandbox && cd ~/crew-sandbox && crew repl'

# Then use:
crew-safe
```

---

## Status

- ✅ Sandbox exists and works
- ✅ SEARCH/REPLACE parsing works  
- ❌ Gateway agents bypass sandbox
- ❌ No safety warnings in REPL
- 🔜 Need local agent execution or gateway sandbox integration

---

## Cleaned Up

Removed the rogue `index.html` from your CrewSwarm repo.

**Going forward, Captain:** `cd` to a test directory before using `crew repl`. Gunns will fire at the correct target.

