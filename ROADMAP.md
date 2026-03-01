# CrewSwarm — Ops / Core Roadmap

> Ops and core product work (telemetry, dashboard, validation). Website feature work lives in `website/ROADMAP.md`.

---

## Road to 9/10 — Pre-Beta Checklist

**Goal:** clean, contributor-friendly, regression-protected codebase ready for public beta (`0.1.0-beta`).
**Current state:** 7.5/10 — all features working, naming consistent, Docker ready. Blocked on structure + CI.

### Phase 1 — God-file split ✅ DONE

Extract module boundaries from the three large files. No behavior changes — only move code. Keep entrypoint APIs stable throughout.

**Target files:** `crew-lead.mjs` (5.4k LOC), `gateway-bridge.mjs` (5.4k LOC), `frontend/src/app.js` (5.9k LOC)

**Module boundaries:**

| Module | Path | Extracted from | Status |
|---|---|---|---|
| HTTP routes + handlers | `lib/crew-lead/http-server.mjs` | `crew-lead.mjs` | ✅ |
| Pipeline engine + orchestration | `lib/pipeline/` | `crew-lead.mjs` | ✅ |
| Skill loader + runner | `lib/skills/` | `crew-lead.mjs` | ✅ |
| Agent registry + dispatch | `lib/agents/` | `gateway-bridge.mjs` | ✅ |
| Engine adapters (one file per engine) | `lib/engines/` | `gateway-bridge.mjs` | ✅ |
| Tool executor + permissions | `lib/tools/` | `gateway-bridge.mjs` | ✅ |
| Config + env bootstrap | `lib/runtime/` | both | ✅ |
| Dashboard tab modules | `frontend/src/tabs/` | `frontend/src/app.js` | ✅ |

**Acceptance criteria:**
- ✅ `crew-lead.mjs` and `gateway-bridge.mjs` are orchestration-only shells
- ✅ `app.js` imports from tab modules — no tab logic inline
- ✅ Each module has one clear responsibility, testable in isolation
- ✅ All smoke tests pass unchanged

---

### Phase 2 — Smoke-test CI ✅ DONE

- [x] Add `scripts/smoke.sh` — single script capturing current manual smoke commands
- [x] Add `.github/workflows/smoke.yml` (two jobs: static + integration):
  - `npm ci`
  - `cd frontend && npm run build`
  - `node scripts/health-check.mjs --no-services`
  - `node scripts/check-dashboard.mjs --source-only`
  - `bash install.sh --non-interactive`
- [x] Trigger on PR + push to `main`
- [x] CI green on clean clone

**Acceptance criteria:**
- ✅ CI passes on every push (static + integration both green)
- ✅ Fails fast on runtime regressions (syntax errors, missing deps, broken build)
- ✅ Logs useful for debugging failures (bridge logs dumped on agent connection timeout)

---

### Phase 3 — Beta gate ✅ DONE

Do not cut `0.1.0-beta` until all boxes below are checked:

- [x] God-file split complete (Phase 1 done)
- [x] CI smoke green for 5+ consecutive merges (5/5 as of 2026-02-27)
- [x] No P0/P1 regressions from `node scripts/health-check.mjs` (10/10 checks pass)
- [x] `install.sh --non-interactive` succeeds on a clean machine
- [x] `README.md` first-run section verified accurate (fixed: config path, engine count, health cmd)
- [x] `docs/docker.md` tested end-to-end — `docker compose up -d` verified: 14 agents spawn, `/api/health` ok, dashboard serves HTML, crew-lead responds on :5010. Also fixed: build context 6529→325 files, healthcheck URL /health→/api/health.

**All boxes checked — ready to cut `0.1.0-beta`.**

### Phase 4 — Skill system enhancements ✅ DONE (2026-02-28)

Extended skill executor (`lib/skills/index.mjs`) with transformation support for complex API requirements:

- **`_bodyTransform`** — Template string with `{{param}}` placeholders for dynamic request body construction
  - Enables OpenAI-compatible chat APIs (Grok, GPT, Claude) via skills
  - Replaces `{{param}}` with JSON-stringified param values, then parses result
  - Falls back to default behavior if transformation fails
  
- **`_responseExtract`** — Dot-notation path (e.g. `choices[0].message.content`) to extract nested response values
  - Supports bracket notation `[0]` and dot notation `.field`
  - Returns extracted string or JSON-stringified value
  - Falls back to full response if extraction fails

**Use case:** Grok X search and vision skills now work seamlessly with OpenAI chat completions API format.

---

## crew-mega Upgrade (user requested 10x improvement)

**Status:** FAILED (QA audit 2026-02-25) — plan was written into wrong project (polymarket ROADMAP); re-implementation belongs here.

### Issues found (QA)
- Phase 1: System prompt not loaded on agent restart
- Phase 2: Skill plugin not registered
- Phase 4: Fallback model not configured
- Phase 5: Brain context entry not added
- Phase 3 (Custom Tools): Optional, skipped

### Re-implementation tasks (CrewSwarm repo / `~/.crewswarm/` only)

- [x] **Phase 1** — crew-mega prompt in `~/.crewswarm/agent-prompts.json` confirmed present.
- [x] **Phase 2** — `~/.crewswarm/skills/polymarket-strategy.json` exists. Skill appears in `/api/skills`.
- [x] **Phase 4** — `fallbackModel: deepseek/deepseek-reasoner` set in `~/.crewswarm/crewswarm.json`.
- [x] **Phase 5** — crew-mega + Polymarket strategy tips added to `memory/brain.md`.

*(User told crew-lead how to make mega 10x better; this is the implementation checklist.)*

---

## Ops / Telemetry

- [x] Field matrix in `docs/OPS-TELEMETRY-SCHEMA.md` — all fields, types, event types documented
- [x] Heartbeat thresholds and task failure windows documented (agent.presence section)
- [x] Event lifecycle guidance — versioning, unknown fields, retry/backoff rules in schema doc
- [x] Sample telemetry bundles — agent.presence, task.lifecycle, error examples with all required fields
- [x] JSON Schema validation tooling and `scripts/check-dashboard.mjs` payload validation update — `lib/runtime/telemetry-schema.mjs` with 3 event schemas + 5 test vectors; `check-dashboard.mjs --validate-schema / --schema-only`; smoke.sh runs it in CI

---

## Backlog

### Grok/xAI Integration ✅ COMPLETE (2026-03-01)

**Market opportunity:** xAI/Grok integration with advanced capabilities — **SHIPPED via skill system transformation pipeline**

**Status:** 
- ✅ Provider integration (crew-lead)
- ✅ Dashboard UI + enhanced provider hints
- ✅ **Skills working** — `grok.x-search` and `grok.vision` operational via skill transformation layer
- ✅ Skill system extended with `_bodyTransform` / `_responseExtract` support

---

#### Implementation Approach

**Chosen**: Extended skill system with transformation support (pragmatic, general-purpose solution)

**What shipped** (implemented by Cursor CLI agent on 2026-03-01):

1. **Core Infrastructure Enhancement** (`lib/skills/index.mjs`)
   - Added `_bodyTransform`: Template-based request construction with `{{param}}` placeholder substitution
   - Added `_responseExtract`: Dot-notation path extraction (e.g., `choices[0].message.content`)
   - Enables ANY OpenAI-compatible API (Grok, GPT-4, Claude, Gemini) to work as a skill
   - **Backward compatible** — no breaking changes to existing skills

2. **Two Working Skills**
   - `grok.x-search.json` — Real-time Twitter/X search using Grok's `/v1/chat/completions` endpoint
     - Aliases: `x-search`, `twitter-search`, `grok-search`
     - Usage: `@@SKILL grok.x-search {"query": "What's trending on X?"}`
   - `grok.vision.json` — Image analysis with `grok-vision-beta` model
     - Supports JPEG, PNG, WebP, GIF (up to 20MB)
     - Aliases: `grok-vision`, `vision`, `image-analysis`
     - Usage: `@@SKILL grok.vision {"image_url": "...", "prompt": "Describe this"}`

3. **Frontend & Documentation**
   - Enhanced xAI provider hint in dashboard (real-time X access, vision, 128K context)
   - Dashboard rebuilt (`npm run build` completed)
   - Comprehensive docs:
     - `docs/GROK-INTEGRATION.md` (user guide)
     - `docs/GROK-IMPLEMENTATION-SUMMARY.md` (technical deep-dive)
     - Updated `memory/brain.md` with Grok capabilities

---

#### Configuration

```json
// ~/.crewswarm/crewswarm.json
{
  "providers": {
    "xai": {
      "apiKey": "xai-..."
    }
  }
}
```

#### Usage Examples

```bash
# Search X/Twitter in real-time
@@SKILL grok.x-search {"query": "What are people saying about CrewSwarm?"}

# Analyze screenshot
@@SKILL grok.vision {"image_url": "https://example.com/ui.png", "prompt": "Is this accessible?"}

# Use with any agent
@@AGENT crew-researcher "What's trending on X about AI coding tools? Use x-search"
```

---

#### Alternative Implementation Path (Not Chosen)

**See `PDD-GROK-X-SEARCH-INTEGRATION.md`** for a more sophisticated "Option B" approach:
- Native xAI engine adapter with `/v1/responses` endpoint
- Built-in server-side tool support (`x_search`, `web_search`, `code_interpreter`)
- Citations with X post URLs
- Advanced filters (date ranges, handles, image/video understanding)
- Parallel function calling

**Why not implemented**: Skill transformation approach (Option A+) is:
- Simpler (no new engine adapter needed)
- More general (works for ANY OpenAI-compatible API)
- Sufficient for current use cases
- Can be upgraded to Option B later if advanced xAI tool features are needed

**Future enhancement**: If X post citations or advanced filters become critical, implement native xAI tool support per PDD.

---

**Market impact**: ✅ CrewSwarm is now the only AI coding platform with real-time X/Twitter intelligence via Grok.

---

## crew-cli: Grok Integration ✅ COMPLETE

### Native xAI Tool Support ✅ SHIPPED (2026-03-01)
**Status:** Production-ready with full feature set  
**Implementation:** Native tool support via `/v1/responses` API  
**Command:** `crew x-search`

**What shipped**:
- ✅ Native xAI integration (`src/xai/search.ts`)
- ✅ Built-in `x_search` server-side tool
- ✅ **Citations with X post URLs** (source attribution)
- ✅ **Advanced filters**:
  - Date ranges (`--from-date`, `--to-date`)
  - Handle filters (`--allow-handle`, `--exclude-handle`)
  - Image understanding (`--images`)
  - Video understanding (`--videos`)
- ✅ Dedicated CLI command with clean UX

**Usage**:
```bash
# Basic search
crew x-search "What are people saying about AI coding tools?"

# With filters
crew x-search "CrewSwarm" \
  --from-date 2026-02-01 \
  --allow-handle elonmusk \
  --images \
  --json
```

**See**: `GROK-INTEGRATION-STATUS-UPDATE.md` for implementation details and `PDD-GROK-X-SEARCH-INTEGRATION.md` (original plan).

---

## crew-lead: Pending Work

### 1. ~~Fix Grok X-Search~~ ✅ COMPLETE (crew-lead partial, crew-cli full)
**crew-lead status:** ⚠️ Skill transformation (no citations, no advanced filters)  
**crew-cli status:** ✅ Native tool support (citations + advanced filters) — **2026-03-01**

**Summary**:
- crew-lead: Skill-based integration via `@@SKILL grok.x-search` (good enough for most use cases)
- crew-cli: Native `crew x-search` command with full API features (production-ready)

---

### 2. Background Agent System (AutoFix & Maintenance) 🆕
**Status:** Not started (PDD written)  
**Priority:** P1 (competitive feature, high market demand)  
**Effort:** 10-14 days  
**Inspired by:** GitHub Copilot Coding Agent, GitHub Advanced Security Autofix

**What it is**: Background autonomous agent that automatically detects and fixes:
- Security vulnerabilities (CVEs, secrets, dependency issues)
- Code quality issues (linter errors, code smells)
- Test failures (flaky tests, missing coverage)
- Documentation drift (broken links, outdated docs)

**How it works**:
1. **Scan** → Detect issues (CodeQL, ESLint, npm audit, etc.)
2. **Route** → Dispatch to specialized agent (crew-security, crew-fixer, crew-qa)
3. **Fix** → Generate fix in isolated sandbox
4. **Review** → Self-review (run tests, security scan, blast radius)
5. **PR** → Create pull request with full context

**Key features**:
- ✅ Multi-platform (GitHub, GitLab, Bitbucket, local)
- ✅ 14 specialized agents (vs GitHub's single agent)
- ✅ Multi-provider LLMs (not locked to one vendor)
- ✅ More issue types (security, quality, tests, docs, deps)
- ✅ Self-hosted option (keep data private)
- ✅ Configurable limits (max PRs/day, confidence thresholds)

**Competitive advantage**:
- GitHub Copilot: 3x faster vulnerability remediation, but GitHub-only + requires Advanced Security ($)
- CrewSwarm: Open-source, works anywhere, more powerful, specialized agents

**Scheduling options**:
1. GitHub Actions (daily cron job)
2. Continuous daemon (local/self-hosted)
3. On-demand CLI: `crew autofix run`

**Configuration**:
```json
// .crew/autofix.json
{
  "enabled": true,
  "schedule": "0 2 * * *",
  "scanners": {
    "security": {"enabled": true, "severity": ["high", "critical"]},
    "quality": {"enabled": true, "autofix": true},
    "tests": {"enabled": true, "fixFlaky": true}
  },
  "limits": {"maxPRsPerRun": 3, "minConfidence": 0.7}
}
```

**See**: `PDD-BACKGROUND-AGENT-AUTOFIX.md` for complete implementation plan

**Phase breakdown**:
1. Core scanner (3-4 days) — `crew autofix scan`
2. Fix generator (3-4 days) — `crew autofix run --issue <id>`
3. Self-review layer (2-3 days) — validation before PR
4. PR creation (2-3 days) — `gh pr create` with full context
5. Scheduler & daemon (2 days) — `crew autofix daemon`

---

### 3. Upgrade crew-lead to Native xAI Tools (Optional)
**Status:** Not started (optional upgrade)  
**Priority:** P3 (low - crew-lead skill approach is sufficient)  
**Effort:** 2 days  
**Decision criteria:** Only if crew-lead users frequently request citations

**Current state**: crew-lead uses skill transformation approach (no citations, no advanced filters).

**Enhancement path**: Port crew-cli's `src/xai/search.ts` to crew-lead as `lib/engines/xai.mjs`:

**What this unlocks**:
- **Citations with X post URLs** (source attribution)
- **Advanced filters**:
  - Date ranges (`from_date`, `to_date`)
  - Handle filters (`allowed_x_handles`, `excluded_x_handles`)
  - Image/video understanding toggles
- **Additional tools**:
  - `web_search` (general web, not just X)
  - `code_interpreter` (Python sandbox)
  - `collections_search` (RAG over uploaded docs)
- **Parallel function calling** (multiple tools at once)

**Implementation**: See `PDD-GROK-X-SEARCH-INTEGRATION.md` Option B for full plan.

**Decision point**: Only implement if users request citations or advanced filtering. Current skill-based approach is sufficient for 90% of use cases.

---

### 3. Web Search Tool (Grok) - BLOCKED
**Status:** Blocked (requires #2 above)  
**Priority:** P2  
**Effort:** 0 days (comes free with native tool support)

---

### 4. Code Interpreter Tool (Grok) - BLOCKED  
**Status:** Blocked (requires #2 above)  
**Priority:** P2  
**Effort:** 0 days (comes free with native tool support)

---

### 5. Collections Search Tool (Grok) - BLOCKED
**Status:** Blocked (requires #2 above)  
**Priority:** P2  
**Effort:** 1 day (file upload + tool registration)

---

### 6. Multi-Tool Agents - BLOCKED
**Status:** Blocked (requires #2 above)  
**Priority:** P2  
**Effort:** 0 days (automatic once tools available)

---

### 7. Parallel Function Calling (Grok) - BLOCKED
**Status:** Blocked (requires #2 above)  
**Priority:** P2  
**Effort:** 1 day (parallel execution in engine adapter)

---

## crew-cli: Future Enhancements (Optional)

### High Value

#### 1. xAI/Grok Integration for crew-cli
**Status:** Not started  
**Priority:** High (market opportunity)

**Rationale:** While crew-lead has Grok support (partially broken), crew-cli does not. No official Grok CLI exists from xAI, making this a market opportunity.

**Implementation:**
- Add xAI provider to `crew-cli/src/orchestrator/index.ts`
- Support `grok-beta`, `grok-vision-beta` models
- Enable X/Twitter search via routing layer
- Add `--provider xai` flag to commands
- **Depends on:** crew-lead native tool support (#1 above)

**Validation:**
- `crew chat --provider xai "what's trending on X?"`
- `crew dispatch crew-researcher --model grok-beta "analyze sentiment"`

#### 2. Real-World Cost/Speed Benchmark
**Status:** Not started  
**Priority:** High (validation)

**Rationale:** 3-tier architecture predicts 72% cost savings and 10x speed improvement. Need empirical validation.

**Test scenario:**
- Task: Refactor authentication in 10 files
- Sequential baseline: crew-coder (current)
- Parallel test: `crew plan --parallel --concurrency 5`

**Metrics to capture:**
- Total tokens (input + output)
- Total USD cost
- Wall clock time
- Success rate (edits applied correctly)

**Acceptance criteria:**
- Cost reduction >= 50% (target: 72%)
- Speed improvement >= 5x (target: 10x)
- Quality maintained (no regression in edit accuracy)

#### 3. Video Demo of `crew plan --parallel`
**Status:** Not started  
**Priority:** High (marketing/onboarding)

**Content:**
- Show sequential vs parallel execution side-by-side
- Demonstrate cost/speed savings
- Explain worker pool, concurrency, retry logic
- Show `crew memory` recall improving plan quality

**Deliverable:** 3-5 minute video on YouTube/docs site

---

### Medium Value

#### 4. Semantic Memory Deduplication
**Status:** Not started  
**Priority:** Medium (optimization)

**Rationale:** AgentKeeper stores raw entries. Similar tasks create redundant memories.

**Implementation:**
- Embed task/result text on write
- Cluster similar entries (cosine similarity threshold)
- During compaction, merge clusters → single representative entry
- Store: `{merged: [id1, id2, ...], representative: {...}}`

**Benefit:** Reduce memory store size by 30-50% while maintaining recall quality.

#### 5. LSP Auto-Fix Integration
**Status:** Not started  
**Priority:** Medium (developer experience)

**Rationale:** `crew lsp check` finds type errors but doesn't fix them. Agent loop integration would auto-fix.

**Implementation:**
- After agent edit, run `crew lsp check` automatically
- If errors found, dispatch to crew-fixer with error context
- Retry until type-clean or max attempts (3)

**Validation:**
- `crew auto "add TypeScript strict mode" --lsp-auto-fix`
- Errors caught and fixed without manual intervention

#### 6. Repository Map Visualization
**Status:** Not started  
**Priority:** Medium (exploration/debugging)

**Rationale:** `crew map --graph` outputs JSON. Visual graph aids understanding large codebases.

**Implementation:**
- Add `crew map --graph --visualize` flag
- Generate `.dot` file (Graphviz format)
- Auto-open in browser via Graphviz Online or similar
- Highlight: entry points, circular deps, critical paths

**Deliverable:** Interactive HTML graph with zoom/pan/search

---

### Low Value (Nice to Have)

#### 7. Twitter Post Skill Integration
**Status:** Unknown (skill exists but not documented)  
**Priority:** Low  
**Effort:** 1 day

**What:** Complete integration of `twitter.post` skill (`~/.crewswarm/skills/twitter.post.json`)

**Implementation:**
- Audit existing skill definition
- Test OAuth flow for Twitter API v2
- Add to dashboard UI (skill catalog)
- Document usage patterns

**Use case:**
```bash
@@SKILL twitter.post {"status": "Just shipped CrewSwarm v0.1.0! 🚀"}
```

**Note:** Depends on Twitter API access (paid tier required for posting).

---

## Popular CLI Patterns (from competitive research)

**Source**: GitHub Copilot CLI, Gemini CLI, OpenCode analysis  
**Goal**: Adopt best UX patterns from leading terminal AI tools

### 11. Slash Command System (crew-cli) ✅ COMPLETE
**Status:** Shipped (2026-03-01)  
**Priority:** P1 (quick win, better UX)  
**Effort:** 1 day  
**Pattern from:** GitHub Copilot CLI

**What shipped:** Configurable slash-command system in REPL

**Commands:**
```bash
> /model          # Switch models (show picker)
> /lsp            # View LSP server status
> /memory         # Show memory stats
> /help           # List all slash commands
> /exit           # Exit REPL
> /clear          # Clear screen
```

**Features:**
- ✅ Configurable via `.crew/config.json` → `repl.slashCommands`
- ✅ Alias support (define custom shortcuts)
- ✅ Clean dispatcher pattern (no more if/else chain)
- ✅ Help text auto-generated from config

**Implementation:**
- Refactored REPL in `src/repl/index.ts` (lines 136-420)
- LSP handler: line 388
- Memory handler: line 364
- Alias support: line 97

**Validation:**
- ✅ Build passed
- ✅ Tests passed (16/16)
- ✅ Smoke tested: `/model`, `/lsp`, `/memory`, `/help`

---

### 12. Repo-Level Configuration (crew-cli) ✅ COMPLETE
**Status:** Shipped (2026-03-01)  
**Priority:** P1 (team collaboration critical)  
**Effort:** 1 day  
**Pattern from:** GitHub Copilot CLI

**What shipped:** Multi-layer config system with team + user overrides

**Config hierarchy:**
```
1. System defaults (built-in)
2. User config (~/.crewswarm/crew.json)
3. Repo config (.crew/config.json) ← Team-shared
4. User override (.crew/config.local.json) ← Personal (gitignored)
5. Environment overrides (ENV vars)
```

**Features:**
- ✅ Team config: `.crew/config.json` (committed)
- ✅ User override: `.crew/config.local.json` (gitignored)
- ✅ Secret-like key blocking (prevents team config from containing API keys)
- ✅ Redacted display (`crew config show` hides sensitive values)
- ✅ CLI commands: `crew config show|get|set`
- ✅ Wired into all commands (`chat`, `auto`, `dispatch`, `plan`, `repl`)

**Example usage:**
```bash
# View merged config
crew config show

# Get specific value
crew config get defaultModel

# Set user override
crew config set defaultModel anthropic/claude-sonnet-4
```

**Implementation:**
- Module: `src/config/repo-config.ts`
- CLI integration: `src/cli/index.ts` (lines 229, 1337)
- Tests: `tests/repo-config.test.js` (16 passing)

**Validation:**
- ✅ Build passed
- ✅ Tests passed
- ✅ Team config loaded correctly
- ✅ Secret keys rejected in team scope
- ✅ User overrides work

---

### 13. GitHub Native Integration (crew-cli) ✅ COMPLETE
**Status:** Shipped (2026-03-01)  
**Priority:** P2 (high value, medium effort)  
**Effort:** 3 days  
**Pattern from:** GitHub Copilot CLI

**What shipped:** Natural language for GitHub operations

**Features:**
```bash
# List issues
crew github "show open issues labeled 'bug'"

# Read specific issue
crew github "what's issue #123 about?"

# Create PR (with confirmation)
crew github "create a PR for my current branch"

# Update issue (with confirmation)
crew github "close issue #456 as completed"
```

**Implementation:**
- Module: `src/github/nl.ts`
- CLI command: `src/cli/index.ts:1422`
- Uses `gh` CLI for GitHub API access
- Confirmation gates for mutating operations (create, update, close)
- LLM-powered intent parsing

**Validation:**
- ✅ Build passed
- ✅ Parser tests added (20/20 passing)
- ✅ `crew github --help` works
- ✅ Confirmation prompts for mutating actions

---

### 14. Animated Banner + Branding (crew-cli) ✅ COMPLETE
**Status:** Shipped (2026-03-01)  
**Priority:** P3 (polish, brand identity)  
**Effort:** 0.5 day  
**Pattern from:** GitHub Copilot CLI

**What shipped:** ASCII art banner on first REPL launch

**Features:**
- ✅ Shows animated banner on first launch
- ✅ Configurable via `.crew/config.json`
- ✅ Can be disabled: `repl.showBanner: false`
- ✅ Can force show: `crew repl --banner`

**Implementation:**
- Location: `src/repl/index.ts:151`
- Config: `src/config/repo-config.ts:18`
- Displays once per session (`.crew/.banner-shown` flag)

**Configuration:**
```json
{
  "repl": {
    "showBanner": true
  }
}
```

---

### 15. Autopilot Mode (Shift+Tab) (crew-cli) ✅ COMPLETE
**Status:** Shipped (2026-03-01)  
**Priority:** P3 (UX improvement)  
**Effort:** 2 days  
**Pattern from:** GitHub Copilot CLI experimental features

**What shipped:** REPL mode toggle with visible state

**Modes:**
1. **chat** (default) — Interactive Q&A with confirmations
2. **autopilot** — Agent continues autonomously until task complete
3. **review** — Read-only, no edits

**Usage:**
- Press `Shift+Tab` to cycle through modes
- Current mode shown in prompt: `[chat]>` or `[autopilot]>` or `[review]>`
- Deterministic cycling: chat → autopilot → review → chat

**Implementation:**
- Mode cycling: `src/repl/index.ts:56`
- Keypress handler: `src/repl/index.ts:85`
- Prompt display: `src/repl/index.ts:188`

**Validation:**
- ✅ Build passed
- ✅ Mode cycles correctly
- ✅ Status visible in prompt
- ✅ Autopilot mode reduces confirmations

---

#### 8. Skill Preprocessor Framework
**Status:** Not started  
**Priority:** Low (infrastructure)  
**Effort:** 2 days

**What:** Generic framework for transforming skill params before execution

**Problem:** Some skills need complex transformations (like `grok.x-search` query → messages format)

**Solution:**
```javascript
// In skill definition
{
  "preprocessor": "grok-search-transform",
  "url": "https://api.x.ai/v1/responses"
}

// In lib/skills/preprocessors/grok-search-transform.mjs
export function transform(params) {
  return {
    model: "grok-beta",
    input: [{ role: "user", content: params.query }],
    tools: [{ type: "x_search" }]
  };
}
```

**Benefit:** Skills can call any API without manual gateway code changes.

---

#### 9. Skill Marketplace / Registry
**Status:** Not started  
**Priority:** Low (community feature)  
**Effort:** 5 days

**What:** Centralized skill registry + install command

**Example:**
```bash
# Browse available skills
crew-lead skills search "twitter"

# Install skill from registry
crew-lead skills install grok-x-search

# Publish your own skill
crew-lead skills publish my-skill.json
```

**Implementation:**
- Create `skills.crewswarm.io` registry API
- Add `lib/skills/registry.mjs` client
- Add `crew-lead skills` CLI commands
- Community contribution workflow

---

#### 10. Agent Collaboration Patterns
**Status:** Not started  
**Priority:** Low (advanced use case)  
**Effort:** 3 days

**What:** Multi-agent workflows with handoffs and approvals

**Example patterns:**
1. **Review chain**: crew-coder → crew-qa → crew-security → approve/reject
2. **Parallel + merge**: crew-researcher-x (X search) + crew-researcher (web) → crew-copywriter (synthesize)
3. **Conditional routing**: crew-pm triages issue → route to crew-coder OR crew-fixer OR crew-frontend

**Implementation:**
- Add `lib/workflows/` directory
- Workflow DSL (YAML or JSON)
- Agent handoff protocol
- State machine executor

**Example workflow:**
```yaml
# ~/.crewswarm/workflows/code-review.yml
name: "Code Review Pipeline"
steps:
  - agent: crew-coder
    task: "Implement feature X"
    outputs: [files_changed]
  - agent: crew-qa
    task: "Audit code quality"
    inputs: [files_changed]
    gates: [approval_required]
  - agent: crew-security
    task: "Security audit"
    inputs: [files_changed]
    gates: [approval_required]
```

---

## Notes

**crew-lead Pending Work**: Items #1-6 above are the next implementation priorities. #1 (Fix Grok X-Search) is **P0** since it's a broken feature.

**crew-cli Future Enhancements**: All items are **optional** and **not blockers** for production use. All core functionality (3-tier architecture, memory, caching, safety gates) is complete and production-ready.

Priority rationale:
- **P0**: Broken features (must fix)
- **P1**: High value, low effort (do next)
- **P2**: High value, medium effort (do later)
- **High Value**: Market differentiation or validation of core claims
- **Medium Value**: User experience improvements, optimizations
- **Low Value**: Nice to have, community features

---

## Summary: What's Left

### ~~Immediate (P0)~~ ✅ COMPLETE
1. ~~Fix Grok X-Search (broken skill)~~ ✅ SHIPPED via skill transformation (2026-03-01)

### High Priority (P1) — Next Up
2. **Background Agent System (AutoFix)** 🆕 — 10-14 days
   - Competitive feature (matches GitHub Copilot)
   - High market demand (automated bug fixing)
   - See `PDD-BACKGROUND-AGENT-AUTOFIX.md`
3. ~~Slash Command System (crew-cli)~~ ✅ COMPLETE (2026-03-01)
4. ~~Repo-Level Configuration (.crew/config.json)~~ ✅ COMPLETE (2026-03-01)

### Medium Priority (P2)
5. ~~Upgrade crew-lead to native xAI tools (optional)~~ — SKIPPED (crew-cli has it)
6. ~~GitHub Native Integration (crew-cli)~~ ✅ COMPLETE (2026-03-01)
7. Real-World Benchmark (crew-cli) — 1 day
8. Video Demo (crew-cli) — 1 day

### Low Priority (Optional)
9. Twitter Post Skill audit — 1 day
10. ~~Animated Banner (crew-cli)~~ ✅ COMPLETE (2026-03-01)
11. ~~Autopilot Mode / Shift+Tab (crew-cli REPL)~~ ✅ COMPLETE (2026-03-01)
12. Skill Marketplace — 5 days
13. Agent Collaboration Patterns — 3 days
14. Semantic Memory Deduplication (crew-cli) — 2 days
15. LSP Auto-Fix (crew-cli) — 1 day
16. Repository Map Visualization (crew-cli) — 2 days

**Total remaining effort (P1)**: ~10-14 days (Background Agent only)  
**Total remaining effort (P1-P2)**: ~12-16 days  
**Total remaining effort (all)**: ~30-38 days

**Recent completions (2026-03-01)**:
- ✅ Grok integration (crew-cli native tool support)
- ✅ Slash command system (crew-cli REPL)
- ✅ Repo-level configuration (crew-cli team collaboration)
- ✅ GitHub native integration (NL for issues/PRs)
- ✅ Animated banner (first-launch branding)
- ✅ Autopilot mode (Shift+Tab cycling)
- ✅ **QA Pass: 98/98 tests passing**
- ✅ **Model recommendations documented**

**Next milestone**: Background Agent System (AutoFix) — matches GitHub Copilot's latest feature while offering more power (14 agents vs 1, multi-platform, open-source).

**Competitive status**: We now have **full feature parity** with GitHub Copilot CLI (slash commands, GitHub integration, autopilot mode, branding) AND exceed them on capabilities (14 agents, multi-provider, Grok integration, 3-tier architecture). Only missing their background agent (our next P1).

---

## 3-Tier Model Stack (Recommended)

**See**: `crew-cli/MODEL-RECOMMENDATIONS.md` for full details

**Tier 1 (Router)**: `google/gemini-2.5-flash-lite` (~$0.01/$0.02 per 1M)  
**Tier 2 (Executor)**: `anthropic/claude-sonnet-4.5` ($3.00/$15.00 per 1M)  
**Tier 3 (Workers)**: `groq/llama-3.3-70b-versatile` (fast) + `openai/gpt-5-mini` (verifier)

**Expected performance**:
- Cost: ~$0.016 per complex task (73% cheaper than single-tier)
- Speed: 15s parallel vs 45s sequential (3x faster)
- Quality: Same or better (specialized models per tier)

**Policy file**: `crew-cli/.crew/model-policy.json` (ready for enforcement)

---

---

(For detailed implementation plans, see `PDD-GROK-X-SEARCH-INTEGRATION.md` and `crew-cli/docs/FUTURE-ENHANCEMENTS.md`.)
