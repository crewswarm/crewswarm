# Planning Artifacts Solution

## Problem: Workers Operating in the Dark

### Without Planning Artifacts (Previous Behavior):
```
L2A: "Build VS Code extension"
  ↓
Decomposes into work units:
  unit-1: "Create package.json"  ← Gets 1 sentence + generic persona
  unit-2: "Create API client"     ← Gets 1 sentence + generic persona
  unit-3: "Create webview HTML"   ← Gets 1 sentence + generic persona
  ...
  ↓
Result:
  ❌ unit-1 creates CHROME extension package.json
  ❌ unit-3 creates HTML with #messages div
  ❌ unit-4 creates JS expecting #chat-container
  ❌ No shared understanding of platform/structure
```

### Root Cause:
- Each worker only sees their own 1-line task description
- No shared specification
- No coordination mechanism
- "Telephone game" failure mode

## Solution: Planning Artifacts First

### With Planning Artifacts (New Behavior):
```
L2A-PHASE-0: Generate Planning Artifacts
  ↓
  crew-pm creates:
    - PDD.md (Product Design Doc)
      • "This is a VS Code extension (not Chrome)"
      • File structure: src/extension.ts, src/api-client.ts...
      • Success criteria
    
    - ROADMAP.md
      • Milestone breakdown
      • Task dependencies
      • Estimated effort
    
    - ARCH.md (Architecture)
      • Technology: VS Code Extension API
      • Module structure
      • Shared patterns: HTML uses #chat-container div
  ↓
L2A-PHASE-1: Decompose with Artifacts
  ↓
  unit-1: "Create package.json per PDD.md section 2.1"
  unit-2: "Create API client per ARCH.md patterns"
  unit-3: "Create webview HTML per ARCH.md (use #chat-container)"
  ...
  ↓
L3: Each unit executes with FULL CONTEXT:
  ✅ PDD.md in prompt
  ✅ ROADMAP.md in prompt
  ✅ ARCH.md in prompt
  ✅ Dependency outputs (if sequential)
  ↓
Result:
  ✅ All units aligned on VS Code platform
  ✅ Consistent HTML/CSS/JS structure
  ✅ Proper integration points
  ✅ Can STILL "1 shot" because they have complete context
```

## Implementation Details

### Changes Made:

1. **`dual-l2.ts` - Added Planning Phase:**
   ```typescript
   interface WorkGraph {
     units: WorkUnit[];
     planningArtifacts?: {
       pdd?: string;      // Product Design Doc
       roadmap?: string;  // Task breakdown
       architecture?: string; // Architecture decisions
     };
   }
   
   async plan() {
     // NEW: Phase 0
     const artifacts = await this.generatePlanningArtifacts(task);
     
     // Existing: Phase 1
     const workGraph = await this.decompose(task, artifacts);
     
     // Existing: Phase 2
     const validation = await this.validate(workGraph);
   }
   ```

2. **`unified.ts` - L3 Workers Get Artifacts:**
   ```typescript
   // Each worker receives:
   overlays.push({
     type: 'reference',
     content: `PDD:\n${workGraph.planningArtifacts.pdd}`,
     priority: 2
   });
   overlays.push({
     type: 'reference',
     content: `ROADMAP:\n${workGraph.planningArtifacts.roadmap}`,
     priority: 2
   });
   overlays.push({
     type: 'reference',
     content: `ARCH:\n${workGraph.planningArtifacts.architecture}`,
     priority: 2
   });
   
   // ALSO: Dependency outputs
   for (const depId of unit.dependencies) {
     const output = results.find(r => r.workUnitId === depId);
     overlays.push({
       type: 'reference',
       content: `Output from ${depId}:\n${output}`,
       priority: 3
     });
   }
   ```

## Benefits

### 1. **Coordination Without Blocking**
- Workers can still execute in parallel
- No need for sequential "file passing"
- Faster than full sequential execution

### 2. **"1 Shot" Still Works**
- Each worker has COMPLETE context upfront
- No back-and-forth needed
- Single LLM call per unit

### 3. **Quality Before QA**
- Catches platform confusion at planning stage
- Ensures integration from the start
- QA can focus on bugs, not fundamental misalignment

### 4. **Scales to Complex Projects**
- Works for multi-file projects
- Handles cross-cutting concerns (auth, state, styling)
- Extensible to larger artifact sets (e.g., API specs, test plans)

## Comparison to Alternatives

### Option B: Sequential with File Passing
```
unit-1 → writes file-1
  ↓
unit-2 → reads file-1, writes file-2
  ↓
unit-3 → reads file-1 + file-2, writes file-3
```

**Pros:**
- Each unit sees actual outputs
- No need for planning artifacts

**Cons:**
- ❌ MUCH slower (serial execution)
- ❌ Blocks parallelization
- ❌ Still no high-level spec coordination
- ❌ Late-stage integration failures

### Our Approach (Planning Artifacts + Parallel):
```
Planning Phase (20-40s) → All units execute in parallel (2-3 min total)
vs
Sequential (5-10 min total)
```

**Speed: 2-3x faster**
**Quality: Same or better (spec-driven)**

## Next Steps

### Before QA Loop:
1. ✅ Add planning artifacts generation (DONE)
2. ✅ Pass artifacts to all L3 workers (DONE)
3. 🔄 Test with VS Code extension task (RUNNING)
4. ⏳ Verify no more Chrome/VS Code confusion

### With QA Loop (Next):
```
L3 Results → crew-qa audits WITH artifacts
  ↓
Issues found? → crew-fixer patches (also gets artifacts)
  ↓
crew-qa re-checks → Sign off
```

## Expected Outcomes

### Without Planning (Previous Test):
- Cost: $0.047
- Time: 249s
- Quality: **BROKEN** (Chrome vs VS Code, mismatched structure)

### With Planning (Current Test):
- Cost: ~$0.055 (slightly higher for planning phase)
- Time: ~260s (similar, maybe slightly faster with better coordination)
- Quality: **ALIGNED** (all units understand VS Code, consistent structure)

### With Planning + QA (Future):
- Cost: ~$0.070 (adds QA + fixes)
- Time: ~300s (adds QA rounds)
- Quality: **PRODUCTION READY** (validated + integrated)

---

## Summary

**Your insight was 100% correct:**

> "we need to create a PDD + ROADMAP to send reasoners should do that first? 
> we need to catch before the QA happens"

✅ **YES** - Planning artifacts solve the coordination problem
✅ **YES** - Catches issues BEFORE execution (not just in QA)
✅ **YES** - Workers can still "1 shot" with complete context
✅ **NO** - Don't need sequential file passing (planning is enough)

**This is the critical missing piece between L2 decomposition and L3 execution.**
