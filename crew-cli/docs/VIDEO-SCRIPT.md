# crew-cli Video Demo Script & Shot List

**Target Duration:** 3-5 Minutes  
**Goal:** Showcase Speculative Execution, Parallel Workers, and Safety Gates.

---

## Shot List & Script

### 1. The Hook (0:00 - 0:30)
- **Visual:** Terminal opening with `crew-cli` banner.
- **Audio/Caption:** "Meet crew-cli: The multi-agent orchestrator that brings speculative execution and zero-risk AI coding to your terminal."
- **Action:** Run `crew` to show the help menu.

### 2. Speculative Execution: Explore Mode (0:30 - 1:30)
- **Visual:** `crew explore "refactor the storage layer to use local SQLite"`
- **Action:** 
    - Show 3 parallel branches spinning up (`minimal`, `clean`, `pragmatic`).
    - Show the "Completed" checkmarks appearing.
    - Run `crew preview explore-clean` to show the diff.
    - Interactively select `explore-clean` to merge.
- **Audio/Caption:** "Don't guess. Explore. `crew explore` implementation strategies in parallel and pick the winner in a safe sandbox."

### 3. Parallel Worker Pool (1:30 - 2:30)
- **Visual:** `crew plan "implement 5 new API endpoints for the user service" --parallel`
- **Action:** 
    - Show the plan being generated.
    - Show the Worker Pool executing multiple tasks at once.
    - Highlight the "3x faster" metrics.
- **Audio/Caption:** "Scale up. Tier 3 workers execute complex plans 3x faster using bounded concurrency."

### 4. Safety Gates & Blast Radius (2:30 - 3:15)
- **Visual:** `crew blast-radius` after a large edit.
- **Action:** 
    - Show the risk score (e.g., HIGH).
    - Show the impacted file list.
    - Run `crew apply --check "npm test"` and show a failure triggering an auto-fix.
- **Audio/Caption:** "Stay safe. Predictive blast-radius analysis and automated fix loops ensure your main branch never breaks."

### 5. DevEx: LSP & Map (3:15 - 3:45)
- **Visual:** `crew lsp check` and `crew map --graph`.
- **Action:** Show the visual repository graph and the type-checking output.
- **Audio/Caption:** "Deep intelligence. Integrated LSP diagnostics and repository mapping give agents full codebase awareness."

### 6. Outro (3:45 - 4:00)
- **Visual:** Link to GitHub and website.
- **Audio/Caption:** "crew-cli: Speculative AI. Zero Risk. Try it today."

---

## Recording Setup

### Option A: asciinema (Recommended for CLI)
```bash
# Start recording
asciinema rec demo.cast

# Perform demo steps...

# Stop with Ctrl+D
# Upload or play back
asciinema play demo.cast
```

### Option B: QuickTime / OBS
- **Resolution:** 1080p or 4K.
- **Font:** Use a clean mono font (Fira Code, JetBrains Mono) at size 14pt+.
- **Theme:** Dark mode (One Dark or similar).
