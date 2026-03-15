# 3-Tier LLM Implementation Plan (crew-cli)

Date: 2026-03-01  
Status: Completed (Phase 5 in `ROADMAP.md` completed on 2026-03-01)

## Scope

This plan maps missing capabilities to a 3-tier execution model:

- Tier 1: Router (cheap/fast classification and simple responses)
- Tier 2: Planner (decomposition + strategy)
- Tier 3: Workers (parallel micro-task execution)

## Capability Implementation Summary

### [x] 1. Parallel Function Calling (Tier 3 workers) ✓ 2026-03-01

Target:
- Execute Tier 2 micro-tasks in parallel with bounded concurrency.

Implementation:
- Add worker pool runner under `src/orchestrator/worker-pool.ts`:
  - queue
  - worker limits
  - retry policy
  - per-task timeout
- Merge worker results into sandbox branches before final merge/apply.

Output/metrics:
- worker success/failure counts
- queue wait time
- end-to-end wall clock reduction vs sequential baseline

### 2. AgentKeeper Memory (cross-tier persistence)

Status: Implemented (2026-03-01)

Target:
- Persist and reuse planning/execution knowledge across runs.

Implementation:
- Add `.crew/agentkeeper.jsonl` and periodic compact summaries.
- Store:
  - Tier 2 plan
  - Tier 3 task results
  - merge outcomes
  - post-run QA signals
- Retrieval by task similarity and path overlap for new runs.

### 3. Token Caching (cost optimization)

Status: Implemented (2026-03-01)

Target:
- Avoid repeated Tier 2 planning calls when task/context are unchanged.

Implementation:
- Cache key: hash(model, task, relevant context blocks, repo state fingerprint).
- Cache store in `.crew/cache/`.
- Cache stats in session cost output: `hits`, `misses`, `tokens_saved`, `usd_saved`.

### 4. Blast Radius Analysis (safe refactoring)

Status: Implemented (2026-03-01)

Target:
- Predict impact before apply for safer autonomous refactors.

Implementation:
- Use dependency graph (`src/mapping/index.ts`) + staged/pending diff.
- Compute impacted files/symbols and risk score.
- Gate `--auto-apply` when risk is high unless override flag is set.

### 5. Collections Search (RAG over docs)

Target:
- Ground planning/execution in local docs and architecture notes.

Implementation:
- Index `docs/` + configurable paths.
- Provide `crew docs search <query>` command.
- Optional context injection into `chat`/`dispatch` and Tier 2 prompts.

## Suggested Delivery Order

1. Parallel function calling  
2. Blast radius analysis  
3. Token caching  
4. AgentKeeper memory  
5. Collections search

## Validation Gates

- Parallel run speedup >= 3x on 10 independent-file tasks.
- Cost reduction measured with token cache enabled.
- Blast-radius gate blocks unsafe auto-apply by default.
- RAG retrieval includes source path and relevance score.
- Memory retrieval improves repeat-task plan quality.
