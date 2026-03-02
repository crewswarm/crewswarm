# Your Use Case: Unified Memory Across All Agents

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WITHOUT Shared Memory (Current)                       │
└─────────────────────────────────────────────────────────────────────────┘

Cursor IDE                 CLI Pipeline              Gateway/RT
    ↓                          ↓                          ↓
.crew/agent-memory/    .crew/agent-memory/      .crew/agent-memory/
  (isolated)              (isolated)               (isolated)
    
❌ User sets budget in Cursor → CLI doesn't know
❌ CLI makes L2 decision → Gateway doesn't see
❌ Claude reviews code → Gemini can't access


┌─────────────────────────────────────────────────────────────────────────┐
│            WITH Shared Memory (2-Line Fix: Set CREW_MEMORY_DIR)          │
└─────────────────────────────────────────────────────────────────────────┘

CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory

        Cursor IDE          CLI Pipeline       Gateway/RT      Claude
            ↓                    ↓                  ↓             ↓
        ┌───────────────────────────────────────────────────────────┐
        │     /shared-memory/.crew/agent-memory/crew-lead.json      │
        │                                                            │
        │  {                                                         │
        │    "agentId": "crew-lead",                                │
        │    "facts": [                                              │
        │      {                                                     │
        │        "content": "Budget: $50k",                          │
        │        "provider": "cursor",  ← From Cursor               │
        │        "critical": true                                    │
        │      },                                                    │
        │      {                                                     │
        │        "content": "L2 Decision: execute-parallel",         │
        │        "provider": "cli-pipeline",  ← From CLI            │
        │        "critical": true                                    │
        │      },                                                    │
        │      {                                                     │
        │        "content": "Task status: 60% complete",             │
        │        "provider": "gateway",  ← From Gateway             │
        │        "critical": false                                   │
        │      },                                                    │
        │      {                                                     │
        │        "content": "Code review: TypeScript fixes needed",  │
        │        "provider": "claude",  ← From Claude               │
        │        "critical": false                                   │
        │      }                                                     │
        │    ]                                                       │
        │  }                                                         │
        └───────────────────────────────────────────────────────────┘
            ↑                    ↑                  ↑             ↑
        All agents read/write same file!

✅ Cursor sets budget → CLI sees it immediately
✅ CLI makes L2 decision → Gateway displays it
✅ Claude reviews code → Gemini uses findings
✅ Codex designs API → Everyone knows endpoints


┌─────────────────────────────────────────────────────────────────────────┐
│                     Your Workflow: "1 Project CLI Bypass"                │
└─────────────────────────────────────────────────────────────────────────┘

Step 1: User works in Cursor
┌──────────────────────────────────────┐
│ Cursor IDE                            │
│                                       │
│ User: "Build dashboard, budget $50k"  │
│   ↓                                   │
│ memory.remember()                     │
│   - Budget: $50k                      │
│   - Deadline: March 15                │
│   - Tech: React + TypeScript          │
└──────────────────────────────────────┘
           ↓ Writes to shared-memory/.crew/agent-memory/crew-lead.json

Step 2: CLI reads Cursor's context
┌──────────────────────────────────────┐
│ CLI Pipeline                          │
│                                       │
│ $ npm run crew -- build dashboard    │
│   ↓                                   │
│ memory.recall()                       │
│   → "Budget: $50k, Deadline: Mar 15" │
│   → "Tech: React + TypeScript"        │
│   ↓                                   │
│ L2: execute-parallel (uses context)   │
└──────────────────────────────────────┘
           ↓ Writes L2 decision to crew-lead.json

Step 3: Gateway sees CLI progress
┌──────────────────────────────────────┐
│ Gateway/RT Agent                      │
│                                       │
│ memory.recall()                       │
│   → "L2 Decision: execute-parallel"  │
│   → "Budget: $50k" (from Cursor)     │
│   ↓                                   │
│ Updates UI: "Building dashboard..."  │
└──────────────────────────────────────┘
           ↓ Writes status to crew-lead.json

Step 4: Claude reviews with full context
┌──────────────────────────────────────┐
│ Claude Agent                          │
│                                       │
│ memory.recall()                       │
│   → "Budget: $50k" (Cursor)          │
│   → "L2 Decision: ..." (CLI)         │
│   → "Task status: ..." (Gateway)     │
│   ↓                                   │
│ Reviews code with project context    │
└──────────────────────────────────────┘
           ↓ Writes review findings to crew-lead.json

Step 5: Gemini (Crew-Lead) orchestrates
┌──────────────────────────────────────┐
│ Gemini (Crew-Lead Agent)              │
│                                       │
│ memory.recall()                       │
│   → Full history from all agents     │
│   ↓                                   │
│ Makes informed decisions:             │
│   - Respects $50k budget (Cursor)    │
│   - Follows L2 plan (CLI)            │
│   - Uses task status (Gateway)       │
│   - Applies code fixes (Claude)      │
└──────────────────────────────────────┘

Result: ALL agents work from shared context!


┌─────────────────────────────────────────────────────────────────────────┐
│                         Memory Flow Diagram                              │
└─────────────────────────────────────────────────────────────────────────┘

Cursor  →  [REMEMBER] Budget, Deadline, Tech Stack
              ↓
            crew-lead.json (CRITICAL facts)
              ↓
CLI     →  [RECALL] User preferences
        →  [REMEMBER] L2 Decision
              ↓
            crew-lead.json (+L2 decision)
              ↓
Gateway →  [RECALL] L2 Decision, User preferences
        →  [REMEMBER] Task status
              ↓
            crew-lead.json (+Task status)
              ↓
Claude  →  [RECALL] Full context
        →  [REMEMBER] Code review findings
              ↓
            crew-lead.json (+Review findings)
              ↓
Gemini  →  [RECALL] Everything
        →  Makes crew-lead decisions with full context


┌─────────────────────────────────────────────────────────────────────────┐
│                            Setup (2 Steps)                               │
└─────────────────────────────────────────────────────────────────────────┘

Step 1: Add to .env
──────────────────────────────────────────────────────────────────────────
CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
──────────────────────────────────────────────────────────────────────────

Step 2: All agents automatically use shared location
──────────────────────────────────────────────────────────────────────────
✅ CLI: Reads CREW_MEMORY_DIR from .env
✅ Gateway: Reads CREW_MEMORY_DIR from .env
✅ Cursor: Set via MCP or environment
✅ Claude: Set via environment
✅ Codex: Set via environment
──────────────────────────────────────────────────────────────────────────

Done! All agents now share memory via crew-lead.json


┌─────────────────────────────────────────────────────────────────────────┐
│                         Benefits for Your Workflow                       │
└─────────────────────────────────────────────────────────────────────────┘

✅ No Re-Asking User Preferences
   - Cursor: "Budget $50k"
   - CLI: Already knows (doesn't ask again)

✅ Seamless Context Handoff
   - Claude reviews code → Gemini applies fixes
   - CLI plans task → Gateway shows progress
   - Codex designs API → Everyone uses same endpoints

✅ Cross-Model Continuity
   - Start with DeepSeek
   - Switch to Gemini mid-task
   - All context preserved

✅ Crash Recovery
   - CLI crashes during L3 execution
   - Restart → Recalls L2 decision
   - Continues from where it left off

✅ Audit Trail
   - Full history of decisions
   - Who decided what, when
   - Debug issues easily


┌─────────────────────────────────────────────────────────────────────────┐
│                    File Structure (Your Setup)                           │
└─────────────────────────────────────────────────────────────────────────┘

/Users/jeffhobbs/Desktop/CrewSwarm/
│
├── .env
│   └── CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
│
├── shared-memory/  ← Shared by ALL agents
│   └── .crew/
│       └── agent-memory/
│           ├── crew-lead.json      ← Main coordination (all agents)
│           ├── cursor-agent.json   ← Cursor-specific memory
│           ├── claude-agent.json   ← Claude-specific memory
│           ├── codex-agent.json    ← Codex-specific memory
│           ├── gemini-agent.json   ← Gemini-specific memory
│           └── pipeline.json       ← CLI pipeline-specific
│
├── crew-cli/
│   ├── src/pipeline/agent-memory.ts  ← Implementation
│   └── .env → CREW_MEMORY_DIR set
│
├── crew-gateway/
│   └── .env → CREW_MEMORY_DIR set
│
└── crew-rt/
    └── .env → CREW_MEMORY_DIR set


┌─────────────────────────────────────────────────────────────────────────┐
│                           Summary                                        │
└─────────────────────────────────────────────────────────────────────────┘

Question: "Share memories between Cursor/Claude/Codex and Crew-Lead?"

Answer:  ✅ YES! Set CREW_MEMORY_DIR in .env

Setup:   2 minutes (1 line in .env)
Works:   All agents on same filesystem
Memory:  Stored in shared-memory/.crew/agent-memory/crew-lead.json
Real-time: File-based (no real-time sync, but fast enough)

Upgrade Path:
  → Redis backend for real-time pub/sub
  → HTTP API for distributed systems
```
