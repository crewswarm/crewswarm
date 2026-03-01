# 🎯 REAL BENCHMARK TASK: VS Code Extension MVP

## Task Overview
**Build Phase 1 (MVP) of the CrewSwarm VS Code extension per the ROADMAP.md**

This is a PERFECT benchmark because it requires:
- ✅ PM to create architecture plan
- ✅ Backend coder to build API client
- ✅ Frontend coder to build webview UI  
- ✅ QA to write tests
- ✅ Security to audit extension permissions
- ✅ Multiple file types (TypeScript, HTML, JSON, CSS)
- ✅ Real-world complexity (200-400 LOC per file)

---

## Task Prompt

```
Build the MVP (Phase 1) of a VS Code extension for CrewSwarm per the specs in:
- /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/ide-extension/ROADMAP.md
- /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/ide-extension/PDD.md

Output to: /Users/jeffhobbs/Desktop/benchmark-vscode-extension/

Requirements from ROADMAP Phase 1:
1. Extension scaffold with package.json and command contributions
2. Webview chat UI with message bridge (extension <-> webview)
3. API client for POST /v1/chat with streaming support
4. Action parser for patches/files/commands from response
5. Diff preview and apply flow via WorkspaceEdit
6. Status bar item showing connection status
7. Basic branding (icon, colors, name)

Deliverables:
- package.json with extension manifest
- src/extension.ts (main extension entry point)
- src/api-client.ts (CrewSwarm API integration)
- src/webview/chat.html (chat UI)
- src/webview/chat.js (webview logic)
- src/webview/styles.css (UI styling)
- src/diff-handler.ts (patch preview/apply)
- README.md (setup and usage instructions)
- tests/extension.test.ts (basic extension tests)

All code must be production-ready with:
- Error handling and retry logic
- TypeScript types
- Comments explaining complex logic
- VS Code API best practices
```

---

## Expected Execution Flow

### Wave 1: Planning (crew-pm)
**Task:** Read ROADMAP.md and PDD.md, create detailed architecture document
**Output:** ARCHITECTURE.md with component breakdown, API contracts, file structure
**Time:** ~30-60s
**Cost:** ~$0.002

### Wave 2: Backend (crew-coder-back)
**Tasks:**
1. Create package.json with VS Code extension manifest
2. Build src/extension.ts with activation logic
3. Build src/api-client.ts with /v1/chat integration
4. Build src/diff-handler.ts for patch operations

**Output:** 4 TypeScript files, ~800-1000 LOC total
**Time:** ~120-180s
**Cost:** ~$0.015

### Wave 3: Frontend (crew-coder-front + crew-frontend)
**Tasks:**
1. Build src/webview/chat.html with message UI
2. Build src/webview/chat.js with webview logic  
3. Build src/webview/styles.css with branded styling

**Output:** 3 web files, ~400-600 LOC total
**Time:** ~90-120s
**Cost:** ~$0.010

### Wave 4: Documentation & Tests (crew-qa)
**Tasks:**
1. Create README.md with setup instructions
2. Create tests/extension.test.ts with unit tests
3. Validate all files compile and load

**Output:** 2 files, ~300-400 LOC total
**Time:** ~60-90s
**Cost:** ~$0.008

### Wave 5: Security Audit (crew-security)
**Task:** Audit extension for security issues (permissions, XSS, CSP)
**Output:** SECURITY-AUDIT.md with findings
**Time:** ~30-45s
**Cost:** ~$0.003

---

## Success Metrics

### Quality Checklist (out of 100):
- [ ] 15pts - All 9 deliverable files present
- [ ] 15pts - package.json has valid VS Code manifest
- [ ] 10pts - TypeScript compiles without errors
- [ ] 10pts - Has proper error handling (try/catch)
- [ ] 10pts - Has TypeScript types/interfaces
- [ ] 10pts - Has streaming API support
- [ ] 10pts - Has diff preview logic
- [ ] 10pts - Has status bar integration
- [ ] 5pts - Has CSS styling with branding
- [ ] 5pts - Has test file with assertions

### Performance Targets:
- Total Time: < 7 minutes
- Total Cost: < $0.05
- Code Quality: > 75/100

---

## Why This Is The Perfect Benchmark:

1. **MULTI-AGENT**: Requires PM, Backend, Frontend, QA, Security
2. **MULTI-FILE**: 9+ files across multiple languages
3. **REALISTIC**: Actual production task, not toy example
4. **MEASURABLE**: Clear acceptance criteria from ROADMAP
5. **ROLE-SPECIFIC**: Backend does API, Frontend does UI, QA does tests
6. **COMPLEXITY**: ~1500-2000 total LOC with real logic
7. **VERIFIABLE**: Can check if extension actually loads in VS Code

---

## Comparison Points vs Other Stacks:

After running with all 5 stacks, compare:

1. **Architecture Quality** - Does PM create good plan?
2. **API Client Code** - Error handling? Retry logic? Types?
3. **UI Code** - Clean HTML? Proper event handling? Styled?
4. **Test Coverage** - Do tests actually validate functionality?
5. **Security** - Does audit catch real issues?
6. **File Structure** - Is project organized logically?
7. **Documentation** - Is README clear and complete?

---

## Run Command:

```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli

# For each stack:
export CREW_USE_UNIFIED_ROUTER=true
export CREW_DUAL_L2_ENABLED=true

# Grok stack:
export CREW_CHAT_MODEL=groq/llama-3.1-8b-instant
export CREW_REASONING_MODEL=grok-4-1-fast-reasoning
export CREW_EXECUTION_MODEL=groq/llama-3.1-8b-instant

node --import=tsx scripts/benchmark-vscode-extension.mjs
```

This will PROVE if the system can handle real-world multi-agent orchestration!
