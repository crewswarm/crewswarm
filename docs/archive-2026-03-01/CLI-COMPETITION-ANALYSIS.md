# CrewSwarm CLI vs Competition - Complete Feature Comparison

**Date**: 2026-03-01  
**Analysis**: What we have, what they have, what's missing

---

## 🎯 Quick Answer

**Do we have Codex CLI features?** ✅ Mostly yes (missing: cloud tasks, native multi-agent)  
**Do we have Gemini CLI features?** ✅ Mostly yes (missing: PTY support)  
**Do we have OpenCode features?** ✅ YES - we ARE an OpenCode integration  
**Do we have Aider features?** ✅ Partially (missing: repo map, voice-to-code)  
**Does Groq have a CLI?** ❌ NO (community tools only, no official)

---

## Feature Matrix

| Feature | Gunns (crew-cli) | Codex CLI | Gemini CLI | OpenCode | Aider | Groq |
|---------|------------------|-----------|------------|----------|-------|------|
| **Interactive REPL** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes (TUI) | ✅ Yes | ❌ No |
| **File Operations** | ✅ Yes (via gateway) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Git Integration** | ✅ Auto-context | ✅ Auto-commit | ✅ Yes | ✅ Yes | ✅ Auto-commit | ❌ No |
| **Multi-file Edits** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Code Review** | ✅ crew-qa | ✅ Separate agent | ⚠️ Manual | ✅ Yes | ❌ Manual | ❌ No |
| **Model Switching** | ✅ --model flag | ✅ /model command | ✅ Auto-route | ✅ Yes | ✅ --model flag | ❌ No |
| **Image Inputs** | ❌ No | ✅ Yes | ⚠️ Via API | ✅ Yes | ✅ Yes | ❌ No |
| **Web Search** | ✅ crew-lead | ✅ Yes | ⚠️ Via API | ❌ No | ❌ No | ❌ No |
| **Voice Mode** | ✅ `crew listen` | ❌ No | ❌ No | ❌ No | ✅ Yes | ❌ No |
| **Sandbox/Preview** | ✅ /preview /apply | ⚠️ Approval mode | ⚠️ Checkpoints | ⚠️ Yes | ❌ Git only | ❌ No |
| **Multi-Agent** | ✅ Pipeline system | ✅ Experimental | ❌ No | ⚠️ Via agents | ❌ No | ❌ No |
| **MCP Support** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Headless/CI Mode** | ✅ `crew headless` | ✅ Scripts | ✅ Yes | ✅ `opencode run` | ✅ Scripts | ❌ No |
| **Team Sync** | ✅ `crew sync` | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Cost Tracking** | ✅ `crew cost` | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Browser Tools** | ✅ Debug/diff/fix | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Multi-repo Context** | ✅ `crew repos-*` | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **LSP Integration** | ❌ No | ❌ No | ❌ No | ✅ Yes | ❌ No | ❌ No |
| **PTY Support** | ❌ No | ⚠️ Via commands | ✅ Native | ⚠️ Yes | ❌ No | ❌ No |
| **Repo Mapping** | ❌ No | ⚠️ Via context | ⚠️ Via context | ⚠️ Via context | ✅ Yes | ❌ No |
| **Cloud Tasks** | ❌ No | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Voice-to-Code** | ⚠️ Via `listen` | ❌ No | ❌ No | ❌ No | ✅ Yes | ❌ No |

**Legend:**  
✅ = Full feature  
⚠️ = Partial/via workaround  
❌ = Missing

---

## Detailed Feature Breakdown

### OpenAI Codex CLI (2026)

**What they have:**
- ✅ Full-screen TUI with syntax highlighting
- ✅ GPT-5.3-Codex + Spark models
- ✅ Image inputs (screenshots, designs)
- ✅ Separate code review agent
- ✅ Experimental multi-agent workflows
- ✅ Web search built-in
- ✅ **Codex Cloud Tasks** - Launch cloud environments
- ✅ MCP (Model Context Protocol)
- ✅ 15+ slash commands (/permissions, /diff, /plan, /agent)
- ✅ Approval modes (user control)
- ✅ Conversation resume

**What we have:**
- ✅ REPL mode
- ✅ Multi-model support (not locked to GPT-5.3)
- ❌ No image inputs (yet)
- ✅ crew-qa for code review
- ✅ Full pipeline multi-agent system (better than "experimental")
- ✅ Web search via crew-lead
- ❌ No cloud tasks
- ✅ MCP support
- ✅ Many commands (40+) but different design
- ✅ Sandbox approval (/preview /apply)
- ✅ Session history

**Missing:**
- ❌ Image inputs
- ❌ Cloud task environments
- ❌ Slash commands in REPL (we have CLI flags)

---

### Google Gemini CLI (2025-2026)

**What they have:**
- ✅ **PTY (pseudo-terminal) support** - Interactive vim, top, git rebase
- ✅ Gemini 3 Flash + 3 Pro auto-routing
- ✅ Context files (GEMINI.md)
- ✅ Token caching
- ✅ Sandboxing + checkpoints
- ✅ Keyboard shortcuts
- ✅ Custom commands
- ✅ Theme customization
- ✅ Headless mode
- ✅ Open-source (Apache 2.0)
- ✅ Free via personal Google accounts

**What we have:**
- ❌ No PTY support (can't run interactive tools natively)
- ✅ Multi-model routing (not just Gemini)
- ✅ Context files (project brain.md, ROADMAP.md)
- ❌ No token caching (yet)
- ✅ Sandboxing (SEARCH/REPLACE blocks)
- ⚠️ Basic keyboard shortcuts
- ⚠️ Limited customization
- ✅ Headless mode
- ✅ Open-source (MIT)
- ✅ Works with any API key

**Missing:**
- ❌ **PTY support** (big one - can't run interactive tools)
- ❌ Token caching
- ❌ Theme customization

---

### OpenCode CLI

**What they have:**
- ✅ 75+ LLM provider support
- ✅ Multiple execution modes (TUI, run, serve, web, acp)
- ✅ **LSP integration** (Language Server Protocol)
- ✅ File operations (read, write, edit, patch)
- ✅ Shell execution (bash)
- ✅ Code search (grep, glob, list)
- ✅ Agent management
- ✅ GitHub Actions integration
- ✅ MCP servers
- ✅ Session continuation/forking
- ✅ Remote server attachment

**What we have:**
- ✅ Multi-provider support (via gateway)
- ✅ REPL + headless + CI modes
- ❌ **No LSP integration** (can't see type errors)
- ✅ File operations (via gateway tools)
- ✅ Shell execution (via gateway)
- ✅ Git context (better than grep/glob)
- ✅ Agent management (crew-main, crew-coder, etc.)
- ⚠️ No direct GitHub Actions (but have CI mode)
- ✅ MCP servers
- ✅ Session management
- ❌ No remote server attachment

**Missing:**
- ❌ **LSP integration** (type checking, autocomplete)
- ❌ Remote server attachment
- ❌ GitHub Actions direct integration

---

### Aider (Open-source leader)

**What they have:**
- ✅ **Repository mapping** - Understands entire codebase structure
- ✅ **Coordinated multi-file edits** - Changes across files in one conversation
- ✅ Git auto-commit with descriptive messages
- ✅ 75+ LLM provider support
- ✅ Model-agnostic (swap mid-session)
- ✅ Works with any editor (IDE watch mode)
- ✅ **Voice-to-code** capability
- ✅ Image/web page inputs
- ✅ Copy/paste mode for web chat
- ✅ Lint + test integration
- ✅ 100+ language support
- ✅ 40,000+ GitHub stars (most popular)
- ✅ Free (Apache 2.0)

**What we have:**
- ❌ **No repo mapping** (agents don't build codebase graph)
- ✅ Multi-file edits (via pipeline or gateway)
- ✅ Git context auto-injection
- ✅ Multi-model support
- ✅ Model switching (--model flag)
- ✅ Works standalone
- ✅ Voice mode (`crew listen`)
- ❌ No image inputs
- ❌ No copy/paste mode
- ⚠️ Test integration (via `crew ci-fix`)
- ✅ Multi-language support
- ⚠️ Smaller community (newer)
- ✅ Open-source (MIT)

**Missing:**
- ❌ **Repository mapping** (Aider's killer feature)
- ❌ Image inputs
- ❌ IDE watch mode

---

### Groq (Inference Company)

**Official CLI:** ❌ **NONE**

**Community Tools:**
- groq-code-cli (701 stars)
- Cline CLI (with Groq support)
- groqcli (basic wrapper)
- groq-ai-toolkit (Python)

**All are basic API wrappers, no advanced features.**

**Why this matters:** Groq has the **fastest inference** (300-600 tok/sec) but **NO official CLI**. This is a market gap.

---

## What We Have That NO ONE Else Has

### 🎯 Unique to Gunns (crew-cli)

1. **Multi-agent Pipeline System**
   - Wave-based parallel execution
   - crew-pm, crew-qa, crew-coder orchestration
   - Quality gates (QA → fix loop)

2. **Team Sync + Privacy Controls**
   - `crew sync` - Share corrections across team
   - Privacy controls for sensitive code

3. **Browser Automation Suite**
   - `crew browser-debug` - Chrome debug + screenshot
   - `crew browser-diff` - Visual comparison
   - `crew browser-fix` - Auto-fix UI errors

4. **Multi-repo Context**
   - `crew repos-scan` - Detect sibling repos
   - `crew repos-context` - Cross-repo awareness
   - `crew repos-warn` - API breaking change detection

5. **Cost Tracking & Estimation**
   - `crew cost` - Usage tracking
   - `crew estimate` - Pre-task cost prediction

6. **CI Fix Loop**
   - `crew ci-fix` - Run tests, auto-fix failures
   - Max retry logic

7. **Voice + TTS**
   - `crew listen` - Whisper transcription
   - ElevenLabs TTS integration

8. **Sourcegraph Integration**
   - `crew src` - Batch codemods

9. **Sandbox Branches**
   - `crew branch` - Sandbox versioning
   - `crew merge` - Merge sandbox changes

10. **Local Corrections Dataset**
    - `crew correction` - Record user fixes
    - `crew tune` - Export training data

---

## Critical Missing Features

### 1. ❌ **LSP Integration** (OpenCode has this)
- Can't see type errors in real-time
- No autocomplete from codebase
- No jump-to-definition

### 2. ❌ **PTY Support** (Gemini CLI has this)
- Can't run interactive tools (vim, top, git rebase)
- No real-time terminal interaction

### 3. ❌ **Repository Mapping** (Aider has this)
- No codebase graph/structure awareness
- Agents don't understand file relationships

### 4. ❌ **Image Inputs** (Codex, Aider have this)
- Can't attach screenshots
- No design → code workflow

### 5. ❌ **Cloud Tasks** (Codex has this)
- No containerized execution environments
- All runs locally

### 6. ❌ **Token Caching** (Gemini CLI has this)
- Re-sends same context repeatedly
- Higher costs

---

## Our Strengths

✅ **Best multi-agent orchestration** (pipelines + quality gates)  
✅ **Most comprehensive CLI** (40+ commands)  
✅ **Unique team features** (sync, privacy, corrections)  
✅ **Browser automation** (no one else has this)  
✅ **Multi-repo awareness** (unique)  
✅ **Cost controls** (tracking + estimation)  
✅ **Voice mode** (rare)  
✅ **Gateway flexibility** (can use ANY model/engine)

---

## OpenCode Integration

**Important:** We ARE compatible with OpenCode!

Our gateway supports:
- OpenCode runtime (`useOpenCode` flag)
- Multi-provider routing
- Session management

We're not competing with OpenCode - we're a **layer on top** that adds:
- Multi-agent orchestration
- Team sync
- Browser tools
- CI automation
- Voice mode

**OpenCode = Single-agent execution engine**  
**Gunns = Multi-agent orchestrator + team tooling**

---

## Summary Matrix

| Capability | Score | Notes |
|------------|-------|-------|
| **File Operations** | 🟢 Excellent | Via gateway + sandbox |
| **Git Integration** | 🟢 Excellent | Auto-context + review |
| **Multi-Model Support** | 🟢 Excellent | 75+ via gateway |
| **Code Review** | 🟢 Excellent | crew-qa + quality gates |
| **Multi-Agent** | 🟢 **Best-in-class** | Pipeline system |
| **Team Features** | 🟢 **Unique** | Sync + privacy + corrections |
| **Browser Tools** | 🟢 **Unique** | Debug + diff + fix |
| **Voice Mode** | 🟡 Good | Basic Whisper STT |
| **Sandbox Safety** | 🟡 Good | SEARCH/REPLACE blocks |
| **Cost Controls** | 🟢 **Unique** | Track + estimate |
| **LSP Integration** | 🔴 Missing | OpenCode has this |
| **PTY Support** | 🔴 Missing | Gemini CLI has this |
| **Repo Mapping** | 🔴 Missing | Aider has this |
| **Image Inputs** | 🔴 Missing | Codex/Aider have this |
| **Cloud Tasks** | 🔴 Missing | Codex has this |

---

**Verdict:** We're the **most comprehensive CLI** but missing some **quality-of-life features** (LSP, PTY, repo mapping, images).

**Positioning:** "The lethal multi-agent CLI with team superpowers."

**Next moves:**
1. Add LSP integration (huge DX win)
2. Add repository mapping (match Aider)
3. Add image inputs (match Codex)
4. Build standalone mode (remove gateway dependency)
5. Add token caching (reduce costs)

**Target acquired, Captain. We have unique firepower (multi-agent, team, browser) but need to reload on DX features (LSP, PTY, repo mapping).** 💥
