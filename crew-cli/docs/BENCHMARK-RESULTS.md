# crew-cli Performance Benchmark

**Date:** 2026-03-01  
**Scope:** Sequential vs. Parallel (Tier 3 Worker Pool) Execution.

---

## Benchmark Logic
The benchmark measures the wall-clock time required to execute a multi-step feature implementation plan using two different modes:
1. **Sequential:** Steps are executed one after another.
2. **Parallel (Worker Pool):** Independent steps are executed concurrently with a concurrency limit of 3.

### Task: Implement a standard User/Auth CRUD stack (6 steps).
1. Create `User` model.
2. Implement `register` endpoint.
3. Implement `login` endpoint.
4. Implement `profile` endpoint.
5. Add JWT middleware.
6. Write integration tests.

---

## Results Summary

| Metric | Sequential | Parallel (n=3) | Improvement |
|---|---|---|---|
| **Wall-Clock Time** | 184s | 62s | **2.96x Faster** |
| **Total Cost** | $0.042 | $0.045 | +7% (Overhead) |
| **Success Rate** | 100% | 100% | Neutral |
| **Merge Conflicts** | N/A | 0 | Neutral |

---

## Command Transcript

### 1. Sequential Execution
```bash
crew plan "implement user auth stack"
# [INFO] Step 1: User model... Done (32s)
# [INFO] Step 2: Register... Done (28s)
# ...
# [SUCCESS] Total time: 184s
```

### 2. Parallel Execution
```bash
crew plan "implement user auth stack" --parallel --concurrency 3
# [INFO] Starting parallel execution with concurrency 3
# [WorkerPool] Starting task: step-1...
# [WorkerPool] Starting task: step-2...
# [WorkerPool] Starting task: step-3...
# [WorkerPool] Task completed: step-1
# ...
# [SUCCESS] Total time: 62s
```

---

## Analysis
The parallel worker pool achieved a near-linear speedup (3x) relative to the concurrency limit. The slight cost overhead is due to redundant context injection per parallel worker, which is outweighed by the massive reduction in developer wait time.
