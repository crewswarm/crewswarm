# Dashboard "CLI Process" Tab — WTF Does It Mean?

**TL;DR**: This tab is for configuring **crew-cli's 3-tier architecture** when you run it standalone. It's confusing because:
1. The mode toggle is misleading
2. The model options are incomplete
3. The "MODEL STACK" shows "Not configured" even when it IS configured
4. The QA model dropdown uses chat models when it should use reasoning models

---

## 🔁 "Connected Mode" vs "Standalone Mode"

**What it actually means:**

| Mode | What happens |
|------|-------------|
| **Connected Mode** | crew-cli routes tasks through **crew-lead → gateway → 20 agents** (the full CrewSwarm stack) |
| **Standalone Mode** | crew-cli runs its own **3-tier pipeline locally** (L1 Router → L2 Planner → L3 Workers) without needing crew-lead or gateway |

**Why it's confusing:** The button shows "🔌 Connected Mode" but doesn't actually change anything — it just stops/starts the orchestration status polling. The actual mode is determined by how you start `crew-cli` (with `--mode standalone` or `--mode connected`).

**What you should know:**
- **Standalone** = crew-cli is self-contained, uses its own 3-tier architecture
- **Connected** = crew-cli delegates to the full CrewSwarm gateway/agent ecosystem

---

## 🧠 The 3-Tier Architecture (What These Dropdowns Configure)

crew-cli uses a **3-tier LLM pipeline** for cost optimization and speed:

```
User Request
    ↓
┌─────────────────────────────────────────────────┐
│ TIER 1 (L1): ROUTER                              │
│ Fast classification: Is this chat/code/dispatch?│
│ Model: gemini-2.5-flash-lite (cheapest/fastest) │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│ TIER 2 (L2): PLANNER                             │
│ Breaks task into micro-tasks, creates work graph│
│ Model: claude-sonnet-4.5 or deepseek-reasoner   │
│                                                  │
│ L2A: Planning artifacts (PDD, ROADMAP, ARCH)    │
│ L2B: Validator (cost/risk gates, policy checks) │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│ TIER 3 (L3): WORKERS                             │
│ Parallel execution of micro-tasks               │
│ Model: gemini-2.5-flash, deepseek-chat, etc.    │
│                                                  │
│ + QA Auditor (quality checks after execution)   │
└─────────────────────────────────────────────────┘
```

**Cost optimization:** L1 uses dirt-cheap models (< $0.0001/req), L2 uses mid-tier ($0.002-0.01/req), L3 parallelizes cheap workers.

---

## 📋 What Each Dropdown Does

### CREW_ROUTER_MODEL (L1)
**Purpose**: Fast intent classification (chat vs code vs dispatch)  
**Default**: `gemini-2.5-flash-lite` (free tier)  
**Options shown**:
- ❌ Missing: `gemini-2.5-flash-lite` (the actual default!)
- ✅ Gemini 2.5 Flash
- ✅ DeepSeek Chat
- ✅ Grok 4 Fast

**Problem**: The dropdown doesn't include the default model that's actually used

---

### CREW_REASONING_MODEL (L2 Main)
**Purpose**: Task decomposition and strategy planning  
**Default**: `claude-sonnet-4.5` or `deepseek-reasoner`  
**Options shown**:
- ✅ Claude Sonnet 4.5
- ✅ DeepSeek Reasoner
- ✅ Gemini 3.1 Pro
- ✅ Grok 4 Fast

**This one is correct!**

---

### CREW_L2A_MODEL (L2A Planning Artifacts)
**Purpose**: Generates PDD, ROADMAP, ARCH documents  
**Default**: Same as `CREW_REASONING_MODEL`  
**Options shown**:
- ✅ DeepSeek Reasoner (recommended for deep reasoning)
- ✅ Claude Sonnet 4.5
- ✅ Gemini 3.1 Pro
- ✅ Grok 4 Fast

**This one is correct!**

---

### CREW_L2B_MODEL (L2B Validator)
**Purpose**: Cost/risk gates, policy validation  
**Default**: `deepseek-chat` or `claude-sonnet-4.5`  
**Options shown**:
- ✅ Claude Sonnet 4.5
- ✅ GPT-4o
- ✅ DeepSeek Chat

**Problem**: Missing Grok! You asked "why no grok here?" — **it should be there**.

---

### CREW_EXECUTION_MODEL (L3 Workers)
**Purpose**: Parallel code/content generation workers  
**Default**: `gemini-2.5-flash` (fast & cheap)  
**Options shown**:
- ✅ Gemini 2.5 Flash (Fast & Cheap) ← **Correct default**
- ✅ DeepSeek Chat
- ✅ Grok 4 Fast
- ✅ Claude Sonnet 4.5 (Premium)
- ✅ Llama 3.3 70B (Groq - Fast)
- ✅ Qwen 2.5 Coder 32B

**This one is the best!** Includes all the right options.

---

### CREW_QA_MODEL (QA Auditor)
**Purpose**: Quality checks, bug detection after L3 execution  
**Default**: `gemini-2.5-flash` (fast)  
**Options shown**:
- ✅ Gemini 2.5 Flash (Fast QA)
- ✅ Claude Sonnet 4.5 (Premium QA)
- ✅ DeepSeek Chat
- ✅ GPT-4o Mini

**Problem #1**: You asked "why chat models? should be reasoning?" — **You're 100% correct!** QA should use reasoning models (DeepSeek Reasoner, Grok 4 Reasoning, etc.) to deeply analyze code for bugs and edge cases.

**Problem #2**: Missing Grok reasoning models entirely.

---

## 🛠️ What "MODEL STACK: Not configured" Means

That `orchModelStack` span shows "Not configured" because it's trying to fetch the **live orchestration status** from the gateway, but:

1. **In standalone mode**: crew-cli doesn't report its model stack to the gateway (it's local-only)
2. **In connected mode**: The gateway doesn't expose the crew-cli's internal L1/L2/L3 config via the `/api/agents` endpoint

**The real config** is stored in:
- `localStorage` (browser): `crewswarm_cli_process_config`
- Environment variables when you run `crew-cli`
- `~/.crewswarm/model-policy.json` (if it exists)

---

## 🎯 Summary of Issues

| Issue | What's Wrong | What It Should Be |
|-------|-------------|-------------------|
| **Router Model** | Missing `gemini-2.5-flash-lite` (the actual default) | Add it as first option |
| **L2B Validator** | Missing Grok models | Add `grok-4-1-fast-reasoning` |
| **QA Model** | Using chat models instead of reasoning | Add DeepSeek Reasoner, Grok 4 Reasoning |
| **orchModelStack** | Always shows "Not configured" | Should query crew-cli's actual config |
| **Mode Toggle** | Doesn't actually switch modes | Should call crew-cli API or be removed |

---

## 💡 Recommended Model Configurations

### Ultra-Cheap (Free Tier)
```bash
CREW_ROUTER_MODEL="gemini-2.5-flash-lite"     # Free
CREW_REASONING_MODEL="gemini-2.5-flash"       # $0.075/$0.30 per 1M
CREW_L2A_MODEL="gemini-2.5-flash"             # $0.075/$0.30 per 1M
CREW_L2B_MODEL="deepseek-chat"                # $0.27/$1.10 per 1M
CREW_EXECUTION_MODEL="gemini-2.5-flash-lite"  # Free
CREW_QA_MODEL="gemini-2.5-flash"              # $0.075/$0.30 per 1M
```
**Total**: ~$0.006 per complex task

### Best Quality (Recommended)
```bash
CREW_ROUTER_MODEL="gemini-2.5-flash-lite"     # Free
CREW_REASONING_MODEL="claude-sonnet-4.5"      # $3/$15 per 1M
CREW_L2A_MODEL="deepseek-reasoner"            # $0.55/$2.19 per 1M (deep reasoning)
CREW_L2B_MODEL="claude-sonnet-4.5"            # $3/$15 per 1M (strict validation)
CREW_EXECUTION_MODEL="gemini-2.5-flash"       # $0.075/$0.30 per 1M
CREW_QA_MODEL="deepseek-reasoner"             # $0.55/$2.19 per 1M (reasoning QA)
```
**Total**: ~$0.02-0.05 per complex task

### Max Speed (Groq)
```bash
CREW_ROUTER_MODEL="llama-3.3-70b"             # $0.59/$0.79 per 1M
CREW_REASONING_MODEL="llama-3.3-70b"          # $0.59/$0.79 per 1M
CREW_L2A_MODEL="llama-3.3-70b"                # $0.59/$0.79 per 1M
CREW_L2B_MODEL="llama-3.3-70b"                # $0.59/$0.79 per 1M
CREW_EXECUTION_MODEL="llama-3.3-70b"          # $0.59/$0.79 per 1M
CREW_QA_MODEL="llama-3.3-70b"                 # $0.59/$0.79 per 1M
```
**Total**: ~$0.01 per complex task, **< 2s latency**

---

## 🔧 How to Fix This UI

### 1. Add Missing Models
```javascript
// In frontend/index.html, add to CREW_ROUTER_MODEL:
<option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Free)</option>

// Add to CREW_L2B_MODEL:
<option value="grok-4-1-fast-reasoning">Grok 4 Reasoning</option>

// Replace CREW_QA_MODEL with:
<option value="deepseek-reasoner">DeepSeek Reasoner (Best QA)</option>
<option value="grok-4-1-fast-reasoning">Grok 4 Reasoning</option>
<option value="gemini-2.5-flash">Gemini 2.5 Flash (Fast QA)</option>
<option value="claude-sonnet-4.5">Claude Sonnet 4.5 (Premium QA)</option>
```

### 2. Fix orchModelStack
Query crew-cli's actual config:
```javascript
// In frontend/src/orchestration-status.js, add:
async function fetchCrewCLIConfig() {
  try {
    const config = localStorage.getItem('crewswarm_cli_process_config');
    if (config) {
      const parsed = JSON.parse(config);
      const stack = `L1:${parsed.CREW_ROUTER_MODEL||'auto'} / L2:${parsed.CREW_REASONING_MODEL||'auto'} / L3:${parsed.CREW_EXECUTION_MODEL||'auto'}`;
      document.getElementById('orchModelStack').textContent = stack;
    }
  } catch {}
}
```

### 3. Remove or Fix Mode Toggle
Either:
- **Remove it** (it doesn't actually do anything)
- **Make it real**: Have it call crew-cli's `/api/config` endpoint to actually switch modes

---

## ✅ Bottom Line

**What you should know:**
1. **Gemini 2.5 Flash** is a real working model (it's the recommended default for L3 workers)
2. **All 3 tiers work** — this is a proven architecture (benchmarks show 2.96x speedup)
3. **QA should use reasoning models** — you're right, chat models are wrong here
4. **Grok is missing** from L2B and QA dropdowns (but it should be there)
5. **"Not configured" is a lie** — the config exists in localStorage, the UI just doesn't read it

**The confusion comes from**:
- Incomplete dropdown options
- Misleading labels ("Connected Mode" button that doesn't connect)
- Status display that doesn't query the actual config
- Wrong model categories for QA (chat vs reasoning)

---

**Next steps**: Fix the dropdowns to match the actual model recommendations from `crew-cli/COMPLETE-MODEL-LIST.md` and make the status display actually query the localStorage config.
